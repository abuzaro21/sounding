// Plain node:http. A visitor's cookie maps to exactly one workspace; every engine call is scoped to it. Mutations need a
// custom header (forcing a CORS preflight this server never grants), JSON bodies are capped, and there is no endpoint
// that accepts SQL, a table expression, a database URL or a path.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, maskRow, type Engine } from './engine.ts';
import { Limiter, clientIp } from './net.ts';
import { EXAMPLES } from './agent.ts';
import { POLICY_VERSION, ruleText, type Rule } from './policy.ts';
import type { Effect, Row } from './effects.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const COOKIE = 'snd_sid';
const JSON_LIMIT = 16 * 1024;
export type AppOpts = { engine: Engine; publicDir: string; trustProxyHops: number; secureCookies?: boolean; relaxedLimits?: boolean; rls: boolean };

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const operatorOf = (t: string) => `operator:${tokenHash(`op|${t}`).slice(0, 10)}`;

function maskEffect(e: Effect): Effect {
  return { ...e, before: e.before && maskRow(e.before), after: e.after && maskRow(e.after) };
}
const simView = (s: Row) => ({
  id: s.id, action_id: s.action_id, verdict: s.verdict, created_at: s.created_at, effect_digest: s.effect_digest, schema_fp: s.schema_fp,
  report: s.report, effects: (s.effects as Effect[]).map(maskEffect),
});
const execView = (x: Row) => {
  const r = { ...(x.receipt as Row) };
  const cmp = r.comparison as Row | null;
  if (cmp) r.comparison = { ...cmp, unexpected: (cmp.unexpected as Effect[]).map(maskEffect), missing: (cmp.missing as Effect[]).map(maskEffect),
    changed: (cmp.changed as { approved: Effect; actual: Effect; columns: string[] }[]).map((c) => ({ ...c, approved: maskEffect(c.approved), actual: maskEffect(c.actual) })) };
  return { ...x, receipt: r };
};

export function createApp(o: AppOpts) {
  const { engine } = o;
  const general = o.relaxedLimits ? new Limiter(1000, 1000) : new Limiter(8, 60);
  const heavy = o.relaxedLimits ? new Limiter(1000, 1000) : new Limiter(0.5, 20); // simulate / execute
  const sessions = o.relaxedLimits ? new Limiter(1000, 1000) : new Limiter(1 / 30, 6);

  const json = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > JSON_LIMIT) { req.resume(); return reject(new HttpError(413, 'too-large', 'Body too large.')); }
    const parts: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > JSON_LIMIT) { req.destroy(); reject(new HttpError(413, 'too-large', 'Body too large.')); } else parts.push(c); });
    req.on('end', () => {
      if (!n) return resolve({});
      try { const v = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); }
      catch { reject(new HttpError(400, 'bad-json', 'Body is not a JSON object.')); }
    });
    req.on('error', reject);
  });
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(data.length), ...headers });
    res.end(data);
  };

  async function serveStatic(res: http.ServerResponse, urlPath: string) {
    let rel: string;
    try { rel = decodeURIComponent(urlPath).replace(/^\/+/, ''); } catch { throw new HttpError(400, 'bad-path', 'Bad path.'); }
    let file = path.resolve(o.publicDir, rel || 'index.html');
    if (file !== path.resolve(o.publicDir) && !file.startsWith(path.resolve(o.publicDir) + path.sep)) throw new HttpError(404, 'not-found', 'Not found.');
    let s = await stat(file).catch(() => null);
    if (!s?.isFile()) {
      if (path.extname(rel)) throw new HttpError(404, 'not-found', 'Not found.');
      file = path.join(o.publicDir, 'index.html');
      s = await stat(file).catch(() => null);
      if (!s) throw new HttpError(404, 'not-found', 'Interface not built. Run npm run build.');
    }
    send(res, 200, await readFile(file), { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname, m = req.method ?? 'GET';
    if (p === '/healthz') return send(res, 200, { ok: true, rls_enforced: o.rls, policy: POLICY_VERSION });
    if (!p.startsWith('/api/')) {
      if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed.');
      return serveStatic(res, p);
    }
    const ip = clientIp(req, o.trustProxyHops);
    if (!general.take(ip)) throw new HttpError(429, 'rate-limited', 'Too many requests. Wait a moment.');
    if (m !== 'GET' && req.headers['x-sounding'] !== '1') throw new HttpError(403, 'csrf', 'Missing request header.');
    const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));
    let token = /^[A-Za-z0-9_-]{43}$/.test(cookies[COOKIE] ?? '') ? cookies[COOKIE] : null;
    let ws = token ? await engine.workspaceFor(tokenHash(token)) : undefined;

    if (p === '/api/session' && m === 'POST') {
      let created = false;
      if (!ws) {
        if (!sessions.take(ip)) throw new HttpError(429, 'rate-limited', 'Too many new workspaces from this address. Wait a minute.');
        token = randomBytes(32).toString('base64url');
        ws = await engine.createWorkspace(tokenHash(token));
        created = true;
        res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}${o.secureCookies ? '; Secure' : ''}`);
      }
      return send(res, 200, { workspace: ws, created, operator: operatorOf(token!), examples: EXAMPLES, rules: Object.fromEntries((['OPEN_OBLIGATION', 'FINANCIAL_RETENTION', 'REFUND_TRIGGERED', 'LABEL_VOID', 'TARGET_DRIFT', 'EMPTY', 'LIMIT', 'RESTORE_CONFLICT', 'RESTORE_EXPIRED', 'COLLATERAL_EDIT', 'EXTERNAL_MESSAGE', 'IRREVERSIBLE'] as Rule[]).map((r) => [r, ruleText(r)])), policy: POLICY_VERSION });
    }
    if (!ws || !token) throw new HttpError(401, 'no-session', 'No workspace for this browser. Reload to create one.');
    const op = operatorOf(token);
    const seg = p.split('/').filter(Boolean); // ['api', resource, id?, verb?]
    const idOk = (x: string | undefined) => { if (!x || !/^[a-z]{3}_[0-9a-f]{12}$/.test(x)) throw new HttpError(404, 'not-found', 'Not found.'); return x; };
    const heavyGate = () => { if (!heavy.take(ip)) throw new HttpError(429, 'rate-limited', 'Too many simulations from this address. Wait a moment.'); };

    if (m === 'GET') {
      if (p === '/api/state') return send(res, 200, await engine.state(ws));
      if (p === '/api/audit') return send(res, 200, await engine.auditLog(ws));
      if (seg[1] === 'actions' && seg.length === 3) return send(res, 200, await engine.action(ws, idOk(seg[2])));
      if (seg[1] === 'simulations' && seg.length === 3) return send(res, 200, simView(await engine.simulation(ws, idOk(seg[2]))));
      if (seg[1] === 'executions' && seg.length === 3) return send(res, 200, execView(await engine.execution(ws, idOk(seg[2]))));
      if (p === '/api/records') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter((x) => /^[a-z]{2,3}_[0-9a-z]{1,20}$/.test(x));
        return send(res, 200, await engine.records(ws, String(url.searchParams.get('table')), ids));
      }
    } else if (m === 'POST') {
      const body = await json(req);
      if (p === '/api/reset') { heavyGate(); await engine.reset(ws); return send(res, 200, { ok: true }); }
      if (p === '/api/actions') {
        const b = body as { intent?: string; template?: string; params?: Record<string, number>; exclude?: string[] };
        return send(res, 201, await engine.propose(ws, { intent: b.intent, template: b.template, params: b.params, exclude: Array.isArray(b.exclude) ? b.exclude : [] }, op));
      }
      if (p === '/api/drift') return send(res, 200, await engine.drift(ws, String(body.kind)));
      if (seg[1] === 'actions' && seg[3] === 'simulate') { heavyGate(); return send(res, 200, simView(await engine.simulate(ws, idOk(seg[2])))); }
      if (seg[1] === 'actions' && seg[3] === 'edit') {
        const b = body as { months?: number; days?: number; exclude?: string[]; include?: string[] };
        const num = (v: unknown) => (v === undefined ? undefined : Number(v));
        return send(res, 201, await engine.edit(ws, idOk(seg[2]), { months: num(b.months), days: num(b.days), exclude: Array.isArray(b.exclude) ? b.exclude.slice(0, 200) : [], include: Array.isArray(b.include) ? b.include.slice(0, 200) : [] }, op));
      }
      if (seg[1] === 'simulations' && seg[3] === 'revise') return send(res, 201, await engine.agentRevision(ws, idOk(seg[2])));
      if (seg[1] === 'simulations' && seg[3] === 'approve') return send(res, 201, await engine.approve(ws, idOk(seg[2]), op));
      if (seg[1] === 'simulations' && seg[3] === 'reject') return send(res, 200, await engine.reject(ws, idOk(seg[2]), op, typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined));
      if (seg[1] === 'approvals' && seg[3] === 'execute') { heavyGate(); return send(res, 200, execView(await engine.execute(ws, idOk(seg[2]), String(body.nonce ?? ''), op))); }
      if (seg[1] === 'executions' && seg[3] === 'restore') return send(res, 201, await engine.proposeRestore(ws, idOk(seg[2]), op));
    }
    throw new HttpError(404, 'not-found', 'No such endpoint.');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, data: e.data });
      console.error('[sounding] unhandled', e);
      send(res, 500, { error: 'internal', message: 'Something went wrong. Nothing was executed unless a receipt says so.' });
    });
  });
}
