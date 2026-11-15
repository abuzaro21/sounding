import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Db } from './db.ts';
import { Engine, type EngineOpts } from './engine.ts';
import { createApp } from './http.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export async function start(o: { port?: number; dbUrl: string; relaxedLimits?: boolean; engine?: Partial<EngineOpts> }) {
  const db = new Db(o.dbUrl, Number(env.SND_POOL ?? 6));
  await db.migrate();
  const rls = await db.rlsEnforced();
  if (!rls) console.warn('[sounding] WARNING: this database role bypasses row-level security (superuser or BYPASSRLS). Isolation then rests on query scoping alone.');
  // The approval HMAC key. Approvals are short-lived, so a per-process random key is fine: a restart only invalidates open approvals.
  const engine = new Engine(db, { secret: env.SND_SECRET || randomBytes(32).toString('hex'), outboxHoldS: Number(env.SND_OUTBOX_HOLD_S ?? 60), maxWorkspaces: Number(env.SND_MAX_WORKSPACES ?? 150), ...o.engine });
  const reconciled = await engine.recoverInterrupted();
  await engine.purgeIdle();
  const server = createApp({ engine, publicDir: path.join(root, 'public'), trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0), secureCookies: env.NODE_ENV === 'production', relaxedLimits: o.relaxedLimits, rls });
  await new Promise<void>((r) => server.listen(o.port ?? 0, r));
  const tick = setInterval(() => void engine.dispatch().catch((e) => console.error('[sounding] dispatch failed', e.message)), 5000);
  const purge = setInterval(() => void engine.purgeIdle().catch((e) => console.error('[sounding] purge failed', e.message)), 15 * 60_000);
  tick.unref(); purge.unref();
  const port = (server.address() as { port: number }).port;
  return {
    port, engine, server, reconciled,
    async close() { clearInterval(tick); clearInterval(purge); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!env.DATABASE_URL) { console.error('[sounding] DATABASE_URL is required (see README: docker compose up -d db).'); process.exit(1); }
  if (env.SND_RELAXED_LIMITS === '1' && env.NODE_ENV === 'production') { console.error('[sounding] relaxed limits are for tests only.'); process.exit(1); }
  const app = await start({ port: Number(env.PORT ?? 3000), dbUrl: env.DATABASE_URL, relaxedLimits: env.SND_RELAXED_LIMITS === '1' });
  console.log(`[sounding] listening on :${app.port} (reconciled ${app.reconciled} interrupted execution(s))`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
