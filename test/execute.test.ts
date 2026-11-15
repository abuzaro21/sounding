// G8–G10, G12, G13: approval binding, real execution, the in-transaction verifier, freshness and concurrency.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setup, newWs, digest, count, approvedPurge, receipt, URL } from './helpers.ts';
import type { Effect } from '../src/effects.ts';

const { db, engine } = await setup();
after(() => db.close());

test('an approved, fresh plan executes for real and the receipt matches the database', async () => {
  const ws = await newWs(engine);
  const { b, s2, apr } = await approvedPurge(engine, ws);
  const ids = b.spec.target_ids;
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  const r = receipt(x);
  assert.equal(x.status, 'committed', JSON.stringify(r.checks));
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(await count(db, ws, 'select count(*) as n from customers where workspace_id = $1 and id = any($2)', [ids]), 0, 'the customers are gone');
  assert.equal(r.effects, (s2.effects as Effect[]).length, 'exactly the approved number of changes');
  assert.equal(r.post_state, (await digest(db, ws)).digest, 'the receipt names the state the database is now in');
  assert.equal(await count(db, ws, `select count(*) as n from change_log where workspace_id = $1`), 0, 'the journal does not outlive the transaction');
  assert.equal(await count(db, ws, `select count(*) as n from outbox where workspace_id = $1 and status = 'pending'`), (s2.effects as Effect[]).filter((e) => e.tbl === 'outbox').length, 'messages were queued only now, after commit');
  // Replays, double clicks and other operators cannot use the approval again.
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /already consumed/);
  await assert.rejects(engine.approve(ws, String(s2.id), 'op'), /executed/);
});

test('two simultaneous executions of one approval: exactly one runs', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  const res = await Promise.allSettled([engine.execute(ws, apr.id, apr.nonce, 'op'), engine.execute(ws, apr.id, apr.nonce, 'op'), engine.execute(ws, apr.id, apr.nonce, 'op')]);
  const ok = res.filter((x) => x.status === 'fulfilled');
  assert.equal(ok.length, 1);
  assert.equal((ok[0] as PromiseFulfilledResult<{ status: string }>).value.status, 'committed');
  assert.equal(res.filter((x) => x.status === 'rejected' && /approvals are single-use/.test(String(x.reason))).length, 2);
});

test('two approvals of one simulation, wrong token, wrong operator, rejection, expiry', async () => {
  const ws = await newWs(engine);
  const { s2, apr } = await approvedPurge(engine, ws, 'alice');
  await assert.rejects(engine.approve(ws, String(s2.id), 'bob'), /already has an approval/);
  await assert.rejects(engine.execute(ws, apr.id, 'forged', 'alice'), /token does not match/);
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'bob'), /another operator/);
  await engine.reject(ws, String(s2.id), 'alice');
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'alice'), /already rejected/);
  const before = await digest(db, ws);
  assert.deepEqual(await digest(db, ws), before);

  const short = (await setup({ approvalTtlMs: 1 })).engine;
  const ws2 = await newWs(short);
  const p = await approvedPurge(short, ws2);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(short.execute(ws2, p.apr.id, p.apr.nonce, 'op'), /expired/);
  await short.db.close();
});

test('modifying the plan invalidates the earlier approval', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const c = await engine.edit(ws, b.id, { months: 24 }, 'op');
  assert.notEqual(c.id, b.id);
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /already rejected/);
});

test('an old simulation cannot be approved', async () => {
  const slow = (await setup({ simTtlMs: 1 })).engine;
  const ws = await newWs(slow);
  const a = await slow.propose(ws, { intent: 'Remove inactive customer accounts older than 18 months' }, 'agent');
  const s1 = await slow.simulate(ws, a.id);
  const b = await slow.agentRevision(ws, String(s1.id));
  const s2 = await slow.simulate(ws, b.id);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(slow.approve(ws, String(s2.id), 'op'), /older than 10 minutes/);
  await slow.db.close();
});

test('FAILURE TEST: a dependency created after the simulation is caught by the verifier and rolled back', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const drift = await engine.drift(ws, 'new_order') as { customer: string; order: string };
  const before = await digest(db, ws);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  const r = receipt(x) as ReturnType<typeof receipt> & { comparison: { unexpected: Effect[] }; state_restored: boolean; intact: { checked: number; intact: number } };
  assert.equal(x.status, 'rolled_back');
  // The cheap pre-check could not see a new child row: the customer row itself never changed.
  assert.equal(r.checks.find((c) => c.name === 'row versions')!.ok, true);
  assert.equal(r.checks.find((c) => c.name === 'effects match approval')!.ok, false);
  assert.deepEqual(r.comparison.unexpected.map((e) => e.tbl).sort(), ['invoices', 'order_lines', 'orders']);
  assert.ok(r.comparison.unexpected.some((e) => e.id === drift.order));
  assert.equal(r.state_restored, true);
  assert.equal(r.intact.intact, r.intact.checked);
  assert.deepEqual(await digest(db, ws), before, 'nothing committed');
  assert.equal(await count(db, ws, 'select count(*) as n from customers where workspace_id = $1 and id = any($2)', [b.spec.target_ids]), b.spec.target_ids.length);
  // Recovery: simulate again on current state, the agent excludes the customer, the new plan commits.
  const s3 = await engine.simulate(ws, b.id);
  assert.equal(s3.verdict, 'blocked');
  const c = await engine.agentRevision(ws, String(s3.id));
  assert.ok(!c.spec.target_ids.includes(drift.customer));
  const s4 = await engine.simulate(ws, c.id);
  const apr2 = await engine.approve(ws, String(s4.id), 'op');
  assert.equal((await engine.execute(ws, apr2.id, apr2.nonce, 'op')).status, 'committed');
});

test('FAILURE TEST: a configuration change makes a trigger write rows the simulation never saw; the verifier rolls back', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  await engine.drift(ws, 'ledger_mirroring');
  const before = await digest(db, ws);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  const r = receipt(x) as ReturnType<typeof receipt> & { comparison: { unexpected: Effect[] } };
  assert.equal(x.status, 'rolled_back');
  assert.ok(r.checks.find((c) => c.name === 'row versions')!.ok && r.checks.find((c) => c.name === 'schema unchanged')!.ok, 'binding checks passed: nothing they cover changed');
  assert.ok(r.comparison.unexpected.length > 0 && r.comparison.unexpected.every((e) => e.tbl === 'ledger_entries' && e.op === 'INSERT'));
  assert.deepEqual(await digest(db, ws), before);
  assert.equal(await count(db, ws, 'select count(*) as n from ledger_entries where workspace_id = $1'), 0);
});

test('a record updated after the simulation makes the approval stale before anything runs', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  await engine.drift(ws, 'reopen_case');
  const before = await digest(db, ws);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  assert.equal(x.status, 'refused');
  assert.match(receipt(x).checks.find((c) => c.name === 'row versions')!.detail, /support_cases:cas_/);
  assert.deepEqual(await digest(db, ws), before);
});

test('a row deleted and re-inserted with the same key and content is still detected', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const cus = b.spec.target_ids[3];
  await db.tx(ws, async (q) => {
    const [row] = await q<{ r: object }>('select to_jsonb(a) as r from addresses a where workspace_id = $1 and customer_id = $2', [ws, cus]);
    await q('delete from addresses where workspace_id = $1 and customer_id = $2', [ws, cus]);
    await q('insert into addresses select * from jsonb_populate_record(null::addresses, $1::jsonb)', [JSON.stringify(row.r)]);
  });
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  assert.equal(x.status, 'refused');
  assert.match(receipt(x).checks.find((c) => c.name === 'row versions')!.detail, /addresses:/);
});

test('schema drift: a trigger added after the simulation is refused; with that check disabled the verifier still catches it', async () => {
  const ws = await newWs(engine);
  const p1 = await approvedPurge(engine, ws);
  const ws2 = await newWs(engine);
  const p2 = await approvedPurge(engine, ws2);
  await db.q('*', `create or replace function snd_test_audit() returns trigger language plpgsql as $$ begin
      insert into ledger_entries (workspace_id, id, kind, ref, amount_cents) values (old.workspace_id, 'le_t_' || old.id, 'address_audit', old.id, 0); return null; end $$;
    create trigger zz_test_audit after delete on addresses for each row execute function snd_test_audit();`);
  try {
    const x = await engine.execute(ws, p1.apr.id, p1.apr.nonce, 'op');
    assert.equal(x.status, 'refused');
    assert.equal(receipt(x).checks.find((c) => c.name === 'schema unchanged')!.ok, false);
    engine.hooks.skipSchemaCheck = true;
    const before = await digest(db, ws2);
    const y = await engine.execute(ws2, p2.apr.id, p2.apr.nonce, 'op');
    assert.equal(y.status, 'rolled_back');
    const unexpected = (receipt(y) as unknown as { comparison: { unexpected: Effect[] } }).comparison.unexpected;
    assert.ok(unexpected.length > 0 && unexpected.every((e) => e.tbl === 'ledger_entries'));
    assert.deepEqual(await digest(db, ws2), before);
  } finally {
    engine.hooks.skipSchemaCheck = false;
    await db.q('*', 'drop trigger if exists zz_test_audit on addresses; drop function if exists snd_test_audit();');
  }
});

test('deferred constraint triggers fire inside the measurement, in simulation and execution alike', async () => {
  await db.q('*', `create or replace function snd_test_deferred() returns trigger language plpgsql as $$ begin
      insert into ledger_entries (workspace_id, id, kind, ref, amount_cents) values (old.workspace_id, snd_id('le', 'deferred|' || old.id), 'deferred_audit', old.id, 0); return null; end $$;
    create constraint trigger zz_test_deferred after delete on customers deferrable initially deferred for each row execute function snd_test_deferred();`);
  try {
    const ws = await newWs(engine);
    const { s2, apr } = await approvedPurge(engine, ws);
    const deferred = (s2.effects as Effect[]).filter((e) => e.tbl === 'ledger_entries');
    assert.ok(deferred.length > 0, 'the dry run saw the deferred writes');
    const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
    assert.equal(x.status, 'committed', JSON.stringify(receipt(x).checks));
    assert.equal(await count(db, ws, `select count(*) as n from ledger_entries where workspace_id = $1 and kind = 'deferred_audit'`), deferred.length);
  } finally {
    await db.q('*', 'drop trigger if exists zz_test_deferred on customers; drop function if exists snd_test_deferred();');
  }
});

test('a lost connection during COMMIT is resolved from the durable receipt, not assumed', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const before = await digest(db, ws);
  engine.hooks.beforeCommit = (c) => { (c as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy(); };
  try {
    const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
    assert.equal(x.status, 'rolled_back');
    assert.match(String(receipt(x).reason), /connection was lost during COMMIT/);
  } finally { engine.hooks.beforeCommit = undefined; }
  assert.deepEqual(await digest(db, ws), before);
  assert.equal(await count(db, ws, 'select count(*) as n from customers where workspace_id = $1 and id = any($2)', [b.spec.target_ids]), b.spec.target_ids.length);
});

test('a business write racing the execution waits on the row lock, then fails: no orphan is created', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const cus = b.spec.target_ids[0];
  const other = new pg.Client({ connectionString: URL });
  await other.connect();
  let raced: Promise<unknown> | undefined;
  engine.hooks.beforeCommit = async () => {
    raced = other.query(`begin; select set_config('snd.ws', '${ws}', true);
      insert into orders (workspace_id, id, customer_id, status, placed_at, total_cents) values ('${ws}', 'ord_race', '${cus}', 'processing', now(), 100); commit;`).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300)); // the insert is now blocked on our FOR UPDATE lock
  };
  try {
    const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
    assert.equal(x.status, 'committed');
    const err = await raced as { code?: string };
    assert.equal(err.code, '23503', 'the racing insert failed its foreign key after our commit');
  } finally { engine.hooks.beforeCommit = undefined; await other.query('rollback').catch(() => 0); await other.end(); }
  assert.equal(await count(db, ws, `select count(*) as n from orders where workspace_id = $1 and id = 'ord_race'`), 0);
});

test('an execution interrupted by process death is reconciled at start-up', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  await db.q(ws, `update approvals set status = 'executing' where id = $1`, [apr.id]); // the state a crash leaves
  const n = await engine.recoverInterrupted();
  assert.ok(n >= 1);
  const [a] = await db.q<{ status: string; outcome: string }>(ws, 'select status, outcome from approvals where id = $1', [apr.id]);
  assert.deepEqual(a, { status: 'failed', outcome: 'interrupted' });
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /single-use/);
});

test('workspaces are isolated: by query scope and by row-level security', async () => {
  const wa = await newWs(engine), wb = await newWs(engine);
  const { a, s2, apr } = await approvedPurge(engine, wa);
  await assert.rejects(engine.action(wb, a.id), /not found/);
  await assert.rejects(engine.simulate(wb, a.id), /not found/);
  await assert.rejects(engine.approve(wb, String(s2.id), 'op'), /not found/);
  await assert.rejects(engine.execute(wb, apr.id, apr.nonce, 'op'), /No such approval/);
  assert.ok(await db.rlsEnforced(), 'tests run as a role that cannot bypass RLS');
  // Raw SQL scoped to B cannot see or write A's rows, even naming them explicitly.
  assert.equal(await count(db, wb, `select count(*) as n from customers where workspace_id = $2 or $1 = $1`, [wa]), await count(db, wb, 'select count(*) as n from customers where workspace_id = $1'));
  await assert.rejects(db.q(wb, `insert into ledger_entries (workspace_id, id, kind, ref, amount_cents) values ($1, 'le_x', 'x', 'x', 0)`, [wa]), /row-level security/);
  const deleted = await db.q(wb, `delete from customers where workspace_id = $1 returning id`, [wa]);
  assert.equal(deleted.length, 0);
});

test('the audit log is a verifiable hash chain; editing any event breaks it', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  await engine.execute(ws, apr.id, apr.nonce, 'op');
  const log = await engine.auditLog(ws);
  assert.equal(log.verified, true);
  assert.ok(log.events.length >= 6);
  await db.q(ws, `update audit set data = jsonb_set(data, '{tampered}', 'true') where workspace_id = $1 and seq = 2`, [ws]);
  assert.equal((await engine.auditLog(ws)).verified, false);
});
