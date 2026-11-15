// G11: compensating restoration of a committed, recoverable action, through the same simulate/approve/verify gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newWs, count, approvedPurge, receipt, PURGE } from './helpers.ts';
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
  const causes = (s.report as { summary: { causes: Record<string, number> } }).summary.causes;
  assert.ok(Number.isInteger(causes.restore) && causes.restore > 0, `restored rows are counted as such: ${JSON.stringify(causes)}`);
  const t0 = Date.now() - 1000;
  assert.equal(y!.status, 'committed', JSON.stringify(receipt(y!).checks));
  // Restored rows equal their before-images except updated_at (a VOLATILE column): snd_touch stamps rows the
  // restoration updates with the time of the restoration (Codex R6-12). That is the intended, documented behaviour.
  const cases = (s.effects as Effect[]).filter((e) => e.tbl === 'support_cases').map((e) => e.id);
  assert.ok(cases.length > 0);
  const stamps = await db.q<{ updated_at: Date }>(ws, 'select updated_at from support_cases where workspace_id = $1 and id = any($2)', [ws, cases]);
  assert.ok(stamps.every((r) => r.updated_at.getTime() >= t0), 'updated_at records the restoration');
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
  assert.equal((receipt(y!) as unknown as { irreversible: unknown[] }).irreversible.length, delivered, 'the committed receipt names what was compensated, not unsent (Codex R9-11)');
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
    // The workspace outlived the recovery window, so it goes with every copy of erased data it holds (Codex R6-10):
    // recovery records, simulation before-images, receipts.
    // Age only this workspace past the normal window, so the purge leaves other test files' workspaces alone.
    await short.db.q('*', `update workspaces set created_at = now() - interval '25 hours' where id = $1`, [ws]);
    await engine.purgeIdle();
    for (const t of ['executions', 'simulations', 'customers', 'audit']) {
      assert.equal(await count(short.db, ws, `select count(*) as n from ${t} where workspace_id = $1`), 0, `${t} deleted`);
    }
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
  const reserved = async () => Object.fromEntries((await db.q<{ id: string; reserved: number }>(ws, 'select id, reserved from products where workspace_id = $1', [ws])).map((r) => [r.id, r.reserved]));
  const held = await reserved();
  const lines = await db.q<{ product_id: string; qty: number }>(ws, 'select product_id, sum(qty)::int as qty from order_lines where workspace_id = $1 and order_id = any($2) group by product_id', [ws, b.spec.target_ids]);
  const { s, x } = await run(engine, ws, b.id);
  const e = s.effects as Effect[];
  assert.ok(e.some((z) => z.tbl === 'invoices' && z.after!.status === 'void') && e.some((z) => z.tbl === 'products' && z.op === 'UPDATE'));
  assert.equal(x!.status, 'committed');
  assert.equal(await count(db, ws, `select count(*) as n from orders where workspace_id = $1 and id = any($2) and status = 'cancelled'`, [b.spec.target_ids]), b.spec.target_ids.length);
  // Every line's quantity is released, including several lines of one product in one order (Codex R2-3).
  const freed = await reserved();
  for (const l of lines) assert.equal(held[l.product_id] - freed[l.product_id], l.qty, `${l.product_id} released ${l.qty}`);
  const { x: y } = await run(engine, ws, (await engine.proposeRestore(ws, String(x!.id), 'op')).id);
  assert.equal(y!.status, 'committed');
  const now = await snapshot(db, ws);
  for (const t of TABLES.filter((t) => t !== 'outbox')) assert.deepEqual(now[t], before[t], `${t} restored`);
});

test('customers that referred one another in a cycle are restored together (Codex R6-9)', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  const b = await engine.agentRevision(ws, String((await engine.simulate(ws, a.id)).id));
  const [c1, c2] = b.spec.target_ids;
  await db.q(ws, `update customers set referred_by = case id when $2 then $3 else $2 end where workspace_id = $1 and id in ($2, $3)`, [ws, c1, c2]);
  const before = await snapshot(db, ws);
  const c = await engine.edit(ws, b.id, {}, 'op'); // same scope, planned again on the changed data
  const { s, x } = await run(engine, ws, c.id);
  assert.equal(s.verdict, 'safe');
  assert.equal(x!.status, 'committed');
  const { x: y } = await run(engine, ws, (await engine.proposeRestore(ws, String(x!.id), 'op')).id);
  assert.equal(y!.status, 'committed', JSON.stringify(y!.receipt).slice(0, 300));
  const now = await snapshot(db, ws);
  assert.deepEqual(now.customers, before.customers);
});

test('a queued message changed after the original action blocks its restoration (Codex R6-11)', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  const [m] = await db.q<{ id: string }>(ws, `select id from outbox where workspace_id = $1 and status = 'pending' order by id limit 1`, [ws]);
  await db.q(ws, `update outbox set payload = payload || '{"note":"edited by support"}' where workspace_id = $1 and id = $2`, [ws, m.id]);
  const { s } = await run(engine, ws, (await engine.proposeRestore(ws, String(x.id), 'op')).id);
  assert.equal(s.verdict, 'blocked');
  const f = (s.report as { policy: { findings: { rule: string; rows: { id: string; note: string }[] }[] } }).policy.findings.find((z) => z.rule === 'RESTORE_CONFLICT')!;
  assert.deepEqual(f.rows.map((r) => [r.id, r.note]), [[m.id, 'message changed since']]);
});
