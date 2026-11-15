// Drive one complete gate cycle against a running deployment, over HTTP only, as a visitor would.
// Usage: node scripts/live-check.ts https://example.onrender.com   (exit code 0 only if every check passes)
const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
let cookie = '';
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

async function call(method: string, path: string, body?: unknown, csrf = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== 'GET') headers['x-sounding'] = '1';
  const r = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) as any };
}

const health = await call('GET', '/healthz');
check('health', health.status === 200 && health.body.ok === true, `rls_enforced=${health.body.rls_enforced} policy=${health.body.policy}`);
check('row-level security enforced for the app role', health.body.rls_enforced === true);
const s = await call('POST', '/api/session');
check('session cookie is HttpOnly, SameSite=Strict', /HttpOnly; SameSite=Strict/.test(s.headers.get('set-cookie') ?? '') && !!cookie);
check('security headers', /frame-ancestors 'none'/.test(s.headers.get('content-security-policy') ?? '') && s.headers.get('x-content-type-options') === 'nosniff');
check('mutation without the CSRF header is refused', (await call('POST', '/api/reset', {}, false)).status === 403);
const sql = await call('POST', '/api/actions', { intent: 'DELETE FROM customers; DROP TABLE orders' });
check('SQL is not an accepted request', sql.status === 422, sql.body.message);

const a = await call('POST', '/api/actions', { intent: 'Remove inactive customer accounts older than 18 months' });
const s1 = await call('POST', `/api/actions/${a.body.id}/simulate`);
const d1 = s1.body.report?.durable;
check('dry run measured more than the agent expected', s1.body.effects?.length > a.body.expectation?.rows, `${a.body.expectation?.rows} expected, ${s1.body.effects?.length} measured`);
check('dry run left no durable change', d1?.unchanged === true && d1?.journal_residue_after_rollback === 0 && d1?.deliveries_after === d1?.deliveries_before);
check('unsafe plan blocked', s1.body.verdict === 'blocked', (s1.body.report?.policy?.findings ?? []).filter((f: any) => f.severity === 'block').map((f: any) => f.rule).join(', '));
check('blocked plan cannot be approved', (await call('POST', `/api/simulations/${s1.body.id}/approve`)).status === 409);
const b = await call('POST', `/api/simulations/${s1.body.id}/revise`);
const s2 = await call('POST', `/api/actions/${b.body.id}/simulate`);
check('narrowed plan is safe', s2.body.verdict === 'safe', `${b.body.spec?.target_ids?.length} targets, ${s2.body.effects?.length} effects`);
const apr = await call('POST', `/api/simulations/${s2.body.id}/approve`);
check('approval binds the effect digest', apr.body.binding?.effect_digest === s2.body.effect_digest);
check('wrong nonce refused', (await call('POST', `/api/approvals/${apr.body.id}/execute`, { nonce: 'x' })).status === 409);
const x = await call('POST', `/api/approvals/${apr.body.id}/execute`, { nonce: apr.body.nonce });
check('execution committed with every check passing', x.body.status === 'committed' && (x.body.receipt?.checks ?? []).every((c: any) => c.ok), (x.body.receipt?.checks ?? []).filter((c: any) => !c.ok).map((c: any) => c.name).join(', '));
check('replay refused', (await call('POST', `/api/approvals/${apr.body.id}/execute`, { nonce: apr.body.nonce })).status === 409);
const r = await call('POST', `/api/executions/${x.body.id}/restore`);
const rs = await call('POST', `/api/actions/${r.body.id}/simulate`);
const rapr = await call('POST', `/api/simulations/${rs.body.id}/approve`);
const rx = await call('POST', `/api/approvals/${rapr.body.id}/execute`, { nonce: rapr.body.nonce });
check('restoration simulated, approved and committed', rs.body.verdict === 'safe' && rx.body.status === 'committed');
const audit = await call('GET', '/api/audit');
check('audit hash chain verifies', audit.body.verified === true, `${audit.body.events?.length} events`);
check('reset', (await call('POST', '/api/reset')).status === 200);

const failed = results.filter((c) => !c.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${base}`);
process.exit(failed.length ? 1 : 0);
