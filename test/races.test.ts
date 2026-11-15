// Races and failure timing raised by the Codex R4–R7 reviews: admission before the claim, an edit racing an execution,
// a newer simulation, a stored binding swapped, an acknowledgement lost after COMMIT, and start-up reconciliation
// meeting a live execution.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newWs, approvedPurge, receipt } from './helpers.ts';

const { db, engine } = await setup();
after(() => db.close());

/** A beforeCommit hook that parks executions inside their transaction until released. */
function park(n: number) {
  let release!: () => void, arrived = 0, all!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { all = r; });
  return { hook: async () => { if (++arrived === n) all(); await gate; }, ready, release };
}
const status = async (ws: string, id: string) => (await db.q<{ status: string }>(ws, 'select status from approvals where id = $1', [id]))[0].status;

test('a busy server refuses execution without consuming the approval (Codex R6-5, R7-5)', async () => {
  const e = (await setup()).engine;
  const runs = [];
  for (let i = 0; i < 4; i++) { const ws = await newWs(e); runs.push({ ws, ...(await approvedPurge(e, ws)) }); }
  const p = park(3);
  e.hooks.beforeCommit = p.hook;
  const held = runs.slice(0, 3).map((r) => e.execute(r.ws, r.apr.id, r.apr.nonce, 'op'));
  await p.ready;
  const last = runs[3];
  await assert.rejects(e.execute(last.ws, last.apr.id, last.apr.nonce, 'op'), /busy/);
  assert.equal(await status(last.ws, last.apr.id), 'approved', 'the approval is still usable');
  p.release();
  for (const x of await Promise.all(held)) assert.equal(x.status, 'committed', String((x.receipt as { reason?: string }).reason));
  e.hooks.beforeCommit = undefined;
  assert.equal((await e.execute(last.ws, last.apr.id, last.apr.nonce, 'op')).status, 'committed');
  await e.db.close();
});

test('an edit racing an execution waits for it, then finds the action executed (Codex R6-1)', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const p = park(1);
  engine.hooks.beforeCommit = p.hook;
  try {
    const x = engine.execute(ws, apr.id, apr.nonce, 'op');
    await p.ready;
    const edit = engine.edit(ws, b.id, { months: 24 }, 'op').then(() => 'edited', (err: Error) => err.message);
    const reject = engine.reject(ws, String(apr.binding.simulation_id), 'op').then(() => 'rejected', (err: Error) => err.message);
    await new Promise((r) => setTimeout(r, 300)); // both are now waiting on the action row lock
    p.release();
    assert.equal((await x).status, 'committed');
    assert.match(await edit, /no longer open/);
    assert.match(await reject, /no longer open/);
  } finally { engine.hooks.beforeCommit = undefined; }
  assert.equal((await engine.action(ws, b.id)).status, 'executed', 'not overwritten by the edit');
  const [{ n }] = await db.q<{ n: number }>(ws, `select count(*)::int as n from actions where workspace_id = $1 and parent_id = $2`, [ws, b.id]);
  assert.equal(n, 0, 'no replacement action was created');
});

test('a newer simulation of the same action revokes the older approval (Codex R6-6)', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  await engine.simulate(ws, b.id);
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /already rejected/);
});

test('evidence swapped in storage under an intact signature is refused (Codex R6-4)', async () => {
  const ws = await newWs(engine);
  const { s2, apr } = await approvedPurge(engine, ws);
  // Drop one effect from the stored simulation but leave its stored digest and the signed binding alone.
  await db.q(ws, `update simulations set effects = effects - 0 where id = $1`, [s2.id]);
  const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
  assert.equal(x.status, 'refused');
  assert.equal(receipt(x).checks.find((c) => c.name === 'approval binding')!.ok, false);
});

test('an acknowledgement lost after the server committed is resolved as committed (Codex R2-6, R6-8)', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  // COMMIT succeeded; then the client sees a transport error that carries a code, as a reset socket does.
  engine.hooks.afterCommit = () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); };
  try {
    const x = await engine.execute(ws, apr.id, apr.nonce, 'op');
    assert.equal(x.status, 'committed');
  } finally { engine.hooks.afterCommit = undefined; }
  assert.equal(await status(ws, apr.id), 'consumed');
  const [{ n }] = await db.q<{ n: number }>(ws, 'select count(*)::int as n from customers where workspace_id = $1 and id = any($2)', [ws, b.spec.target_ids]);
  assert.equal(n, 0, 'the deletion committed exactly once');
  await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /single-use/);
});

test('start-up reconciliation waits for a live execution instead of recording a false rollback (Codex R6-2)', async () => {
  const ws = await newWs(engine);
  const { apr } = await approvedPurge(engine, ws);
  // A second server process, already migrated (its DDL would otherwise queue behind the parked transaction's locks).
  const other = (await setup()).engine;
  const p = park(1);
  engine.hooks.beforeCommit = p.hook;
  try {
    const x = engine.execute(ws, apr.id, apr.nonce, 'op');
    await p.ready;
    const rec = other.recoverInterrupted();
    await new Promise((r) => setTimeout(r, 300));
    p.release();
    assert.equal((await x).status, 'committed');
    await rec;
    await other.db.close();
  } finally { engine.hooks.beforeCommit = undefined; }
  const rows = await db.q<{ status: string }>(ws, 'select status from executions where workspace_id = $1 and approval_id = $2', [ws, apr.id]);
  assert.deepEqual(rows.map((r) => r.status), ['committed'], 'one receipt, and it is the true one');
  assert.equal(await status(ws, apr.id), 'consumed');
});

test('a claim resolved by another process before the transaction began is not executed (Codex R6-2)', async () => {
  const ws = await newWs(engine);
  const { b, apr } = await approvedPurge(engine, ws);
  const other = (await setup()).engine; // a second server process starting up right after our claim
  engine.hooks.afterClaim = () => other.recoverInterrupted();
  try {
    await assert.rejects(engine.execute(ws, apr.id, apr.nonce, 'op'), /resolved by another process/);
  } finally { engine.hooks.afterClaim = undefined; await other.db.close(); }
  const [{ n }] = await db.q<{ n: number }>(ws, 'select count(*)::int as n from customers where workspace_id = $1 and id = any($2)', [ws, b.spec.target_ids]);
  assert.equal(n, b.spec.target_ids.length, 'nothing was deleted');
  const rows = await db.q<{ status: string }>(ws, 'select status from executions where workspace_id = $1 and approval_id = $2', [ws, apr.id]);
  assert.deepEqual(rows.map((r) => r.status), ['rolled_back'], 'exactly one receipt: the reconciliation');
});

test('workspace capacity holds under concurrent session creation (Codex R7-4)', async () => {
  await engine.purgeIdle(3600_000); // so the engine's own purge-on-full frees nothing during the test
  const [{ n }] = await db.q<{ n: number }>('*', 'select count(*)::int as n from workspaces');
  const e = (await setup({ maxWorkspaces: n + 1 })).engine;
  const res = await Promise.allSettled([1, 2, 3].map(() => newWs(e)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => /capacity|busy/.test(String((r as PromiseRejectedResult).reason))));
  await e.db.close();
});

test('a workspace has a bounded history (Codex R7-1)', async () => {
  const { QUOTA } = await import('../src/engine.ts');
  const ws = await newWs(engine);
  await db.q(ws, `insert into audit (workspace_id, seq, type, data, prev_hash, hash)
    select $1, 1000 + g, 'drift.new_order', '{}', 'x', 'x' from generate_series(1, $2) g`, [ws, QUOTA.drifts]);
  await assert.rejects(engine.drift(ws, 'ledger_mirroring'), /history limit/);
  await assert.rejects(engine.propose(ws, { intent: 'Cancel unpaid orders older than 14 days' }, 'op'), /history limit/);
  await engine.reset(ws);
  assert.ok(await engine.propose(ws, { intent: 'Cancel unpaid orders older than 14 days' }, 'op'), 'Reset clears it');
});
