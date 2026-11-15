// G5 / G6 / G7: the dry run executes the real mutation, measures every direct and indirect change exactly, leaves no
// durable trace, and its findings change what can be approved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newWs, digest, count, PURGE } from './helpers.ts';
import type { Effect } from '../src/effects.ts';
import { compile } from '../src/agent.ts';

const { db, engine } = await setup();
after(() => db.close());

test('a simulation leaves no durable effect', async () => {
  const ws = await newWs(engine);
  const before = await digest(db, ws);
  const outbox = await count(db, ws, 'select count(*) as n from outbox where workspace_id = $1');
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  const s = await engine.simulate(ws, a.id);
  const r = s.report as { durable: Record<string, unknown> };
  assert.ok((s.effects as Effect[]).length > 200, 'the dry run really changed rows');
  assert.equal(r.durable.journal_residue_after_rollback, 0);
  assert.equal(r.durable.unchanged, true);
  assert.deepEqual(await digest(db, ws), before, 'every business table is byte-identical after the simulation');
  assert.equal(await count(db, ws, 'select count(*) as n from outbox where workspace_id = $1'), outbox, 'no outbox message survived');
  assert.equal(await count(db, ws, `select count(*) as n from change_log where workspace_id = $1`), 0, 'no journal rows survive');
  assert.equal(await count(db, ws, 'select count(*) as n from deliveries where workspace_id = $1'), 0, 'nothing reached a provider');
  await engine.dispatch();
  assert.equal(await count(db, ws, 'select count(*) as n from deliveries where workspace_id = $1'), 0, 'the dispatcher found nothing to send');
});

test('measured effects equal an independent SQL oracle, table by table', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  const ids = a.spec.target_ids;
  const s = await engine.simulate(ws, a.id);
  const effects = s.effects as Effect[];
  const n = (tbl: string, op: string) => effects.filter((e) => e.tbl === tbl && e.op === op).length;
  const c = (sql: string) => count(db, ws, sql, [ids]);
  assert.equal(n('customers', 'DELETE'), ids.length);
  assert.equal(n('orders', 'DELETE'), await c('select count(*) as n from orders where workspace_id = $1 and customer_id = any($2)'));
  assert.equal(n('order_lines', 'DELETE'), await c('select count(*) as n from order_lines l join orders o using (workspace_id) where l.order_id = o.id and l.workspace_id = $1 and o.customer_id = any($2)'));
  assert.equal(n('invoices', 'DELETE'), await c('select count(*) as n from invoices i join orders o on o.workspace_id = i.workspace_id and o.id = i.order_id where i.workspace_id = $1 and o.customer_id = any($2)'));
  assert.equal(n('payments', 'DELETE'), await c('select count(*) as n from payments p join invoices i on i.workspace_id = p.workspace_id and i.id = p.invoice_id join orders o on o.workspace_id = i.workspace_id and o.id = i.order_id where p.workspace_id = $1 and o.customer_id = any($2)'));
  assert.equal(n('shipments', 'DELETE'), await c('select count(*) as n from shipments s join orders o on o.workspace_id = s.workspace_id and o.id = s.order_id where s.workspace_id = $1 and o.customer_id = any($2)'));
  assert.equal(n('subscriptions', 'DELETE'), await c('select count(*) as n from subscriptions where workspace_id = $1 and customer_id = any($2)'));
  assert.equal(n('addresses', 'DELETE'), await c('select count(*) as n from addresses where workspace_id = $1 and customer_id = any($2)'));
  assert.equal(n('support_cases', 'UPDATE'), await c('select count(*) as n from support_cases where workspace_id = $1 and customer_id = any($2)'), 'SET NULL orphaning is measured');
  assert.equal(n('customers', 'UPDATE'), await c('select count(*) as n from customers where workspace_id = $1 and referred_by = any($2) and not (id = any($2))'), 'collateral referral edits on non-target customers');
  const expectedMsgs = ids.length
    + await c(`select count(*) as n from subscriptions where workspace_id = $1 and customer_id = any($2) and status = 'active'`)
    + await c(`select count(*) as n from shipments s join orders o on o.workspace_id = s.workspace_id and o.id = s.order_id where s.workspace_id = $1 and o.customer_id = any($2) and s.status in ('pending','in_transit')`)
    + await c(`select count(*) as n from support_cases where workspace_id = $1 and customer_id = any($2) and status = 'open'`);
  assert.equal(n('outbox', 'INSERT'), expectedMsgs, 'trigger-written messages are measured');
  assert.equal(effects.length, effects.filter((e) => ['DELETE', 'UPDATE', 'INSERT'].includes(e.op)).length);
  // Causes are read from the journal, not assumed.
  const causes = (s.report as { summary: { causes: Record<string, number> } }).summary.causes;
  assert.equal(causes.direct, ids.length);
  assert.ok(causes.cascade > 0 && causes.set_null > 0 && causes.trigger > 0);
});

test('an unsafe plan is blocked, cannot be approved, and the narrowed plan has a different measured effect set', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  const s1 = await engine.simulate(ws, a.id);
  assert.equal(s1.verdict, 'blocked');
  const rules = (s1.report as { policy: { findings: { rule: string; severity: string; roots: string[] }[] } }).policy.findings;
  assert.ok(rules.some((f) => f.rule === 'OPEN_OBLIGATION' && f.severity === 'block'));
  assert.ok(rules.some((f) => f.rule === 'FINANCIAL_RETENTION' && f.severity === 'block'));
  await assert.rejects(engine.approve(ws, String(s1.id), 'op'), /policy violations/);
  const b = await engine.agentRevision(ws, String(s1.id));
  const blocked = new Set(rules.filter((f) => f.severity === 'block').flatMap((f) => f.roots));
  assert.deepEqual(b.spec.target_ids, a.spec.target_ids.filter((id) => !blocked.has(id)), 'exactly the implicated customers were excluded');
  assert.ok(b.spec.target_ids.length < a.spec.target_ids.length);
  const s2 = await engine.simulate(ws, b.id);
  assert.equal(s2.verdict, 'safe');
  assert.notEqual(s2.effect_digest, s1.effect_digest);
  const e2 = s2.effects as Effect[];
  assert.equal(e2.filter((e) => e.tbl === 'invoices' && e.before!.status === 'open').length, 0, 'no unpaid invoice is touched');
  assert.equal(e2.filter((e) => e.tbl === 'subscriptions').length, 0, 'no subscription is touched');
  // The superseded action can no longer be simulated or approved.
  await assert.rejects(engine.simulate(ws, a.id), /superseded/);
  assert.equal((await engine.action(ws, a.id)).status, 'superseded');
});

test('the same action yields identical effects in two simulations (deterministic trigger ids)', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: 'Cancel unpaid orders older than 14 days' }, 'agent');
  const s1 = await engine.simulate(ws, a.id), s2 = await engine.simulate(ws, a.id);
  assert.equal(s1.effect_digest, s2.effect_digest);
  const f = (s1.report as { policy: { findings: { rule: string }[] } }).policy.findings.map((x) => x.rule);
  assert.ok(f.includes('REFUND_TRIGGERED') && f.includes('LABEL_VOID'), 'cancelling surfaces refunds and voided labels');
  await assert.rejects(engine.approve(ws, String(s1.id), 'op'), /newer simulation|policy/);
});

test('the compiler accepts only allowlisted shapes and bounded parameters', () => {
  assert.equal(compile('please delete dormant customers inactive for 2 years').params.months, 24);
  assert.equal(compile('Cancel stale orders older than 3 weeks').params.days, 21);
  assert.throws(() => compile('DELETE FROM customers; DROP TABLE orders'), /plain words/);
  assert.throws(() => compile('remove inactive customers older than 1 month'), /6–120 months/);
  assert.throws(() => compile('drop all orders'), /Not an allowlisted action/);
  assert.throws(() => compile("remove inactive customers older than 18 months'; drop table customers;--"), /plain words/);
  assert.throws(() => compile('remove inactive customers older than 18 months and also all orders'), /Not an allowlisted action/);
});

test('simulation refuses to run if any business table is not journalled', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  await db.q('*', 'alter table addresses disable trigger zzz_capture');
  try {
    await assert.rejects(engine.simulate(ws, a.id), /addresses \(no capture trigger\)/);
  } finally {
    await db.q('*', 'alter table addresses enable trigger zzz_capture');
  }
});

test('a table outside the journalled set that a cascade reaches, or a trigger on a bookkeeping table, stops the simulation', async () => {
  const ws = await newWs(engine);
  const a = await engine.propose(ws, { intent: PURGE }, 'agent');
  // Codex R2-1: a migration adds a child table with ON DELETE CASCADE but no capture trigger.
  await db.q('*', `create table loyalty_cards (workspace_id text not null, id text not null, customer_id text not null, primary key (workspace_id, id),
    foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete cascade)`);
  try {
    await assert.rejects(engine.simulate(ws, a.id), /loyalty_cards \(not journalled, but reachable by foreign key\)/);
  } finally { await db.q('*', 'drop table loyalty_cards'); }
  // Codex R6-3: a trigger on a table that execution writes after verification could make unmeasured writes.
  await db.q('*', `create or replace function zz_side() returns trigger language plpgsql as $$ begin return null; end $$`);
  await db.q('*', 'create trigger zz_side after insert on executions for each row execute function zz_side()');
  try {
    await assert.rejects(engine.simulate(ws, a.id), /executions \(bookkeeping table with a trigger\)/);
  } finally { await db.q('*', 'drop trigger zz_side on executions'); await db.q('*', 'drop function zz_side()'); }
  // Codex R9-2: the same child table in another schema.
  await db.q('*', `create schema zz_other; create table zz_other.loyalty_cards (workspace_id text not null, id text not null, customer_id text not null, primary key (workspace_id, id),
    foreign key (workspace_id, customer_id) references customers(workspace_id, id) on delete cascade)`);
  try {
    await assert.rejects(engine.simulate(ws, a.id), /zz_other\.loyalty_cards \(not journalled, but reachable by foreign key\)/);
  } finally { await db.q('*', 'drop schema zz_other cascade'); }
  // Codex R9-1: a rewrite rule on a bookkeeping table.
  await db.q('*', 'create rule zz_rule as on insert to executions do also notify zz_rule');
  try {
    await assert.rejects(engine.simulate(ws, a.id), /executions \(bookkeeping table with a rewrite rule\)/);
  } finally { await db.q('*', 'drop rule zz_rule on executions'); }
  assert.equal((await engine.simulate(ws, a.id)).verdict, 'blocked', 'with the schema restored, simulation runs again');
});
