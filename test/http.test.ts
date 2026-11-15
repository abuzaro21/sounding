// G15: the public HTTP surface. Sessions, CSRF header, tenant isolation, input limits and the absence of any endpoint
// that takes SQL, a database URL, a table expression or a file path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http.ts';
import { setup, PURGE } from './helpers.ts';

const { db, engine } = await setup();
const publicDir = mkdtempSync(path.join(tmpdir(), 'snd-pub-'));
writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>t</title>');
writeFileSync(path.join(tmpdir(), 'snd-secret.txt'), 'outside the public dir');

async function serve(relaxedLimits: boolean) {
  const app = createApp({ engine, publicDir, trustProxyHops: 0, relaxedLimits, rls: true });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${(app.address() as AddressInfo).port}` };
}
const relaxed = await serve(true), strict = await serve(false);
after(async () => { relaxed.app.close(); strict.app.close(); await db.close(); });

type Res = { status: number; body: Record<string, unknown> & Record<string, any>; headers: Headers };
async function call(base: string, method: string, p: string, o: { cookie?: string; body?: unknown; raw?: string; csrf?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.csrf !== false && method !== 'GET') headers['x-sounding'] = '1';
  if (o.cookie) headers.cookie = o.cookie;
  const r = await fetch(base + p, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
  const text = await r.text();
  let body: Res['body'];
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: r.status, body, headers: r.headers };
}
async function session(base = relaxed.base) {
  const r = await call(base, 'POST', '/api/session');
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  return { cookie, ws: String(r.body.workspace), operator: String(r.body.operator) };
}
const api = (method: string, p: string, cookie: string, body?: unknown) => call(relaxed.base, method, p, { cookie, body });

test('sessions: cookie flags, security headers, CSRF header required, no session means 401', async () => {
  const r = await call(relaxed.base, 'POST', '/api/session');
  const sc = r.headers.get('set-cookie')!;
  assert.match(sc, /^snd_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const cookie = sc.split(';')[0];
  // Same cookie, same workspace.
  assert.equal((await call(relaxed.base, 'POST', '/api/session', { cookie })).body.workspace, r.body.workspace);
  assert.equal((await call(relaxed.base, 'POST', '/api/reset', { cookie, csrf: false })).status, 403);
  assert.equal((await call(relaxed.base, 'POST', '/api/actions', { cookie, csrf: false, body: { intent: PURGE } })).status, 403);
  assert.equal((await call(relaxed.base, 'GET', '/api/state')).status, 401);
  assert.equal((await call(relaxed.base, 'GET', '/api/state', { cookie: 'snd_sid=' + 'A'.repeat(43) })).status, 401, 'an unknown token gets nothing');
});

test('the whole gate works over HTTP, and personal data is masked in the response', async () => {
  const { cookie, operator } = await session();
  const a = await api('POST', '/api/actions', cookie, { intent: PURGE });
  assert.equal(a.status, 201);
  const s1 = await api('POST', `/api/actions/${a.body.id}/simulate`, cookie);
  assert.equal(s1.body.verdict, 'blocked');
  assert.equal((await api('POST', `/api/simulations/${s1.body.id}/approve`, cookie)).status, 409);
  const b = await api('POST', `/api/simulations/${s1.body.id}/revise`, cookie);
  const s2 = await api('POST', `/api/actions/${b.body.id}/simulate`, cookie);
  assert.equal(s2.body.verdict, 'safe');
  const emails = JSON.stringify(s2.body.effects).match(/"email":"[^"]*"/g) ?? [];
  assert.ok(emails.length > 0 && emails.every((e) => /"email":"[^"@]{0,2}\*\*\*@/.test(e)), 'emails are masked');
  const apr = await api('POST', `/api/simulations/${s2.body.id}/approve`, cookie);
  assert.equal(apr.status, 201);
  assert.equal(apr.body.binding.operator, operator, 'the approval is bound to this browser session');
  const bad = await api('POST', `/api/approvals/${apr.body.id}/execute`, cookie, { nonce: 'wrong' });
  assert.equal(bad.status, 409);
  assert.match(String(bad.body.message), /token does not match/);
  const x = await api('POST', `/api/approvals/${apr.body.id}/execute`, cookie, { nonce: apr.body.nonce });
  assert.equal(x.body.status, 'committed', JSON.stringify(x.body).slice(0, 400));
  assert.equal((await api('POST', `/api/approvals/${apr.body.id}/execute`, cookie, { nonce: apr.body.nonce })).status, 409, 'no replay');
  const state = await api('GET', '/api/state', cookie);
  assert.equal(state.body.executions[0].status, 'committed');
});

test('another session cannot read or act on this workspace', async () => {
  const A = await session(), B = await session();
  assert.notEqual(A.ws, B.ws);
  const a = await api('POST', '/api/actions', A.cookie, { intent: PURGE });
  const s = await api('POST', `/api/actions/${a.body.id}/simulate`, A.cookie);
  const rev = await api('POST', `/api/simulations/${s.body.id}/revise`, A.cookie);
  const s2 = await api('POST', `/api/actions/${rev.body.id}/simulate`, A.cookie);
  const apr = await api('POST', `/api/simulations/${s2.body.id}/approve`, A.cookie);
  for (const [m, p] of [['GET', `/api/actions/${a.body.id}`], ['GET', `/api/simulations/${s.body.id}`], ['POST', `/api/actions/${a.body.id}/simulate`],
    ['POST', `/api/simulations/${s2.body.id}/approve`], ['POST', `/api/simulations/${s.body.id}/revise`]] as const) {
    const r = await api(m, p, B.cookie);
    assert.equal(r.status, 404, `${m} ${p} from another session: ${JSON.stringify(r.body)}`);
  }
  // Even holding A's nonce, B cannot execute A's approval.
  const x = await api('POST', `/api/approvals/${apr.body.id}/execute`, B.cookie, { nonce: apr.body.nonce });
  assert.equal(x.status, 409);
  assert.equal(x.body.message, 'No such approval.', 'indistinguishable from an id that does not exist');
  // Every workspace is seeded identically, so ids coincide; isolation shows when A's deletion leaves B's copies intact.
  const ids = (s2.body.effects as { tbl: string; id: string; cause: string }[]).filter((e) => e.tbl === 'customers' && e.cause === 'direct').map((e) => e.id).slice(0, 5).join(',');
  const recs = (c: string) => api('GET', `/api/records?table=customers&ids=${ids}`, c).then((r) => r.body as unknown as unknown[]);
  assert.equal((await recs(B.cookie)).length, 5);
  assert.equal((await api('POST', `/api/approvals/${apr.body.id}/execute`, A.cookie, { nonce: apr.body.nonce })).body.status, 'committed');
  assert.deepEqual(await recs(A.cookie), [], 'A\'s rows are gone');
  assert.equal((await recs(B.cookie)).length, 5, 'B\'s rows with the same ids are untouched');
});

test('no SQL, table expression, path or oversized input gets through', async () => {
  const { cookie } = await session();
  for (const intent of ['DELETE FROM customers; DROP TABLE orders', "remove inactive customers older than 18 months'; drop table customers;--", 'select * from pg_shadow']) {
    const r = await api('POST', '/api/actions', cookie, { intent });
    assert.ok(r.status >= 400 && r.status < 500, intent);
  }
  assert.equal((await api('POST', '/api/actions', cookie, { template: 'raw_sql', params: {} })).status, 422);
  assert.equal((await api('GET', '/api/records?table=customers%20c%2C%20pg_authid&ids=cus_1', cookie)).status, 400);
  assert.equal((await api('GET', '/api/records?table=workspaces&ids=x', cookie)).status, 400, 'control tables are not readable');
  assert.equal((await api('POST', '/api/drift', cookie, { kind: 'drop_table' })).status, 400);
  assert.equal((await api('GET', '/api/actions/1%20or%201=1', cookie)).status, 404);
  assert.equal((await call(relaxed.base, 'POST', '/api/reset', { cookie, raw: '{"a":"' + 'x'.repeat(20000) + '"}' })).status, 413);
  assert.equal((await call(relaxed.base, 'POST', '/api/reset', { cookie, raw: '[1,2]' })).status, 400);
  for (const p of ['/..%2fsnd-secret.txt', '/%2e%2e/snd-secret.txt', '/../../etc/passwd']) {
    const r = await call(relaxed.base, 'GET', p);
    assert.ok(!String(r.body.text ?? '').includes('outside the public dir'), p);
  }
  assert.equal((await call(relaxed.base, 'GET', '/nope.js')).status, 404);
  assert.equal((await call(relaxed.base, 'GET', '/some/route')).status, 200, 'client routes fall back to index.html');
});

test('rate limits: new workspaces per address are capped', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await call(strict.base, 'POST', '/api/session')).status);
  assert.deepEqual(codes.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.ok(codes.slice(6).every((c) => c === 429), codes.join(','));
});

test('reset and workspace deletion leave no rows behind in any table', async () => {
  const { cookie, ws } = await session();
  const a = await api('POST', '/api/actions', cookie, { intent: 'Cancel unpaid orders older than 14 days' });
  await api('POST', `/api/actions/${a.body.id}/simulate`, cookie);
  await api('POST', `/api/actions/${a.body.id}/edit`, cookie, { days: 30 });
  assert.equal((await api('POST', '/api/reset', cookie)).status, 200);
  const before = (await api('GET', '/api/state', cookie)).body.tables;
  assert.equal(before.support_cases, 31, 'exactly one fresh copy of the seed');
  await db.q('*', 'delete from workspaces where id = $1', [ws]);
  const { TABLES } = await import('../src/schema.ts');
  for (const t of [...TABLES, 'deliveries', 'change_log', 'actions', 'simulations', 'approvals', 'executions', 'audit']) {
    const [{ n }] = await db.q<{ n: number }>('*', `select count(*)::int as n from ${t} where workspace_id = $1`, [ws]);
    assert.equal(n, 0, `${t} is empty for the deleted workspace`);
  }
});
