// G11: compensating restoration of a committed, recoverable action, through the same simulate/approve/verify gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newWs, count, approvedPurge, receipt } from './helpers.ts';
import { canonical, stable, type Effect, type Row } from '../src/effects.ts';
import { TABLES, type Table } from '../src/schema.ts';
import type { Engine } from '../src/engine.ts';
import type { Db } from '../src/db.ts';

const { db, engine } = await setup();
const fast = await setup({ outboxHoldS: 0 });
after(async () => { await db.close(); await fast.db.close(); });

/** Every business row of a workspace, minus volatile columns, keyed by table and id. */
async function snapshot(d: Db, ws: string) {
  const out: Record<string, Record<string, string>> = {};
  for (const t of TABLES) {
    const rows = await d.q<{ r: Row }>(ws, `select to_jsonb(x) as r from ${t} x where workspace_id = $1`, [ws]);
    out[t] = Object.fromEntries(rows.map(({ r }) => [String(r.id), canonical(stable(t as Table, r))]));
  }
  return out;
}
async function run(e: Engine, ws: string, aid: string) {
  const s = await e.simulate(ws, aid);
  if (s.verdict !== 'safe') return { s, x: null };
  const apr = await e.approve(ws, String(s.id), 'op');
  return { s, x: await e.execute(ws, apr.id, apr.nonce, 'op') };
}

test('a committed deletion is restored exactly; queued messages are cancelled for real', async () => {
  const ws = await newWs(engine);
  const before = await snapshot(db, ws);
  const { apr } = await approvedPurge(engine, ws);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  assert.equal(x.status, 'committed');
  assert.equal(x.recovery_status, 'available');
  const r = await engine.proposeRestore(ws, String(x.id), 'op');
  const { s, x: y } = await run(engine, ws, r.id);
  assert.equal(s.verdict, 'safe');
  assert.equal(y!.status, 'committed', JSON.stringify(receipt(y!).checks));
  const now = await snapshot(db, ws);
  for (const t of TABLES.filter((t) => t !== 'outbox')) assert.deepEqual(now[t], before[t], `${t} is back to its pre-execution state`);
  const msgs = await db.q<{ status: string }>(ws, 'select status from outbox where workspace_id = $1', [ws]);
  assert.ok(msgs.length > 0 && msgs.every((m) => m.status === 'cancelled'), 'every message the purge queued was cancelled before dispatch');
  await engine.dispatch();
  assert.equal(await count(db, ws, 'select count(*) as n from deliveries where workspace_id = $1'), 0);
  assert.equal((await engine.execution(ws, String(x.id))).recovery_status, 'restored');
  // A second restoration has nothing to restore from.
  const again = await run(engine, ws, (await engine.proposeRestore(ws, String(x.id), 'op')).id);
  assert.equal(again.s.verdict, 'blocked');
});

test('restoration refuses when later changes conflict', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const gone = await db.q<{ email: string }>(ws, 'select email from customers where workspace_id = $1 and id = $2', [ws, b.spec.target_ids[0]]);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  await db.q(ws, `insert into customers (workspace_id, id, name, email, status, last_active_at, created_at) values ($1, 'cus_new1', 'New Signup', $2, 'active', now(), now())`, [ws, gone[0].email]);
  const { s } = await run(engine, ws, (await engine.proposeRestore(ws, String(x.id), 'op')).id);
  assert.equal(s.verdict, 'blocked');
  const f = (s.report as { policy: { findings: { rule: string; rows: { note: string }[] }[] } }).policy.findings.find((x) => x.rule === 'RESTORE_CONFLICT')!;
  assert.match(f.rows[0].note, /email now belongs to cus_new1/);
  assert.equal((s.effects as Effect[]).length, 0, 'nothing is half-restored');
});

test('after messages were delivered, restoration says so and queues compensations; delivered messages stay delivered', async () => {
  const { engine: e, db: d } = fast;
  const ws = await newWs(e);
  const { apr } = await approvedPurge(e, ws);
  const x = await e.execute(ws, apr.id, apr.nonce, 'op');
  while (await e.dispatch() > 0); // the test database holds other workspaces' queues too
  assert.equal(await count(d, ws, `select count(*) as n from outbox where workspace_id = $1 and status = 'pending'`), 0);
  const delivered = await count(d, ws, 'select count(*) as n from deliveries where workspace_id = $1');
  const { s, x: y } = await run(e, ws, (await e.proposeRestore(ws, String(x.id), 'op')).id);
  const f = (s.report as { policy: { findings: { rule: string; rows: unknown[] }[] } }).policy.findings.find((z) => z.rule === 'IRREVERSIBLE')!;
  assert.equal(f.rows.length, delivered);
  assert.equal(y!.status, 'committed');
  assert.equal(await count(d, ws, `select count(*) as n from outbox where workspace_id = $1 and topic like '%.compensate'`), delivered);
  assert.equal(await count(d, ws, 'select count(*) as n from deliveries where workspace_id = $1'), delivered, 'nothing can be unsent');
});

test('the dispatcher moving a message between restore simulation and execution makes the restore stale', async () => {
  const { engine: e } = fast;
  const ws = await newWs(e);
  const { apr } = await approvedPurge(e, ws);
  e.o.outboxHoldS = 3600;
  try {
    const x = await e.execute(ws, apr.id, apr.nonce, 'op');
    const r = await e.proposeRestore(ws, String(x.id), 'op');
    const s = await e.simulate(ws, r.id);
    const a2 = await e.approve(ws, String(s.id), 'op');
    e.o.outboxHoldS = 0;
    while (await e.dispatch() > 0);
    const y = await e.execute(ws, a2.id, a2.nonce, 'op');
    assert.equal(y.status, 'refused');
    assert.match(receipt(y).checks.find((c) => c.name === 'row versions')!.detail, /outbox:/);
  } finally { e.o.outboxHoldS = 0; }
});

test('recovery records expire, and an expired record cannot be restored', async () => {
  const short = await setup({ recoveryMs: 1 });
  try {
    const ws = await newWs(short.engine);
    const { apr } = await approvedPurge(short.engine, ws);
    const x = await short.engine.execute(ws, apr.id, apr.nonce, 'op');
    await new Promise((r) => setTimeout(r, 20));
    const { s } = await run(short.engine, ws, (await short.engine.proposeRestore(ws, String(x.id), 'op')).id);
    assert.ok((s.report as { policy: { findings: { rule: string }[] } }).policy.findings.some((f) => f.rule === 'RESTORE_EXPIRED'));
    await short.engine.purgeIdle();
    const [row] = await short.db.q<{ recovery: unknown; recovery_status: string }>(ws, 'select recovery, recovery_status from executions where id = $1', [x.id]);
    assert.deepEqual(row, { recovery: null, recovery_status: 'expired' }, 'the recoverable copy is actually deleted');
  } finally { await short.db.close(); }
});

test('cancelling stale orders: refunds and voided labels block, the narrowed plan commits and restores', async () => {
  const ws = await newWs(engine);
  const before = await snapshot(db, ws);
  const a = await engine.propose(ws, { intent: 'Cancel unpaid orders older than 14 days' }, 'agent');
  const s1 = await engine.simulate(ws, a.id);
  assert.equal(s1.verdict, 'blocked');
  const b = await engine.agentRevision(ws, String(s1.id));
  assert.equal(b.spec.target_ids.length, a.spec.target_ids.length - 3);
  const { s, x } = await run(engine, ws, b.id);
  const e = s.effects as Effect[];
  assert.ok(e.some((z) => z.tbl === 'invoices' && z.after!.status === 'void') && e.some((z) => z.tbl === 'products' && z.op === 'UPDATE'));
  assert.equal(x!.status, 'committed');
  assert.equal(await count(db, ws, `select count(*) as n from orders where workspace_id = $1 and id = any($2) and status = 'cancelled'`, [b.spec.target_ids]), b.spec.target_ids.length);
  const { x: y } = await run(engine, ws, (await engine.proposeRestore(ws, String(x!.id), 'op')).id);
  assert.equal(y!.status, 'committed');
  const now = await snapshot(db, ws);
  for (const t of TABLES.filter((t) => t !== 'outbox')) assert.deepEqual(now[t], before[t], `${t} restored`);
});
