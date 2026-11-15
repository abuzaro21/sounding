import { randomBytes } from 'node:crypto';
import { Db } from '../src/db.ts';
import { Engine, stateDigest, type EngineOpts } from '../src/engine.ts';
import type { Row } from '../src/effects.ts';

export const URL = process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:55432/sim_test';
export const PURGE = 'Remove inactive customer accounts older than 18 months';

export async function setup(o: Partial<EngineOpts> = {}) {
  const db = new Db(URL, 8);
  await db.migrate();
  const engine = new Engine(db, { secret: 'test-secret', outboxHoldS: 3600, maxWorkspaces: 1e6, ...o });
  return { db, engine };
}
export const newWs = (e: Engine) => e.createWorkspace(randomBytes(16).toString('hex'));
export const digest = (db: Db, ws: string) => db.tx(ws, (q) => stateDigest(q, ws));
export const count = async (db: Db, ws: string, sql: string, params: unknown[] = []) => Number((await db.q<{ n: number }>(ws, sql, [ws, ...params]))[0].n);

/** Plan, simulate, let the agent narrow it, simulate again, approve. Returns the safe simulation and its approval. */
export async function approvedPurge(e: Engine, ws: string, op = 'op') {
  const a = await e.propose(ws, { intent: PURGE }, 'agent');
  const s1 = await e.simulate(ws, a.id);
  const b = await e.agentRevision(ws, String(s1.id));
  const s2 = await e.simulate(ws, b.id);
  if (s2.verdict !== 'safe') throw new Error('revised plan not safe');
  const apr = await e.approve(ws, String(s2.id), op);
  return { a, s1, b, s2, apr };
}
export const receipt = (x: Row) => x.receipt as Row & { checks: { name: string; ok: boolean; detail: string }[] };
