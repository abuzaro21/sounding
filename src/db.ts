// PostgreSQL access. Every business transaction is opened through tx(), which pins the workspace (row-level security
// reads snd.ws), the isolation level and statement/lock timeouts, so no code path can touch rows without a scope.
import pg from 'pg';
import { DDL, SCHEMA_TABLES } from './schema.ts';

export type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
export type Isolation = 'read committed' | 'repeatable read' | 'serializable';
export type TxOpts = { isolation?: Isolation; capture?: string; action?: string; statementMs?: number; lockMs?: number; beforeCommit?: (c: pg.PoolClient) => unknown; afterCommit?: () => unknown };

/** COMMIT failed without a SQLSTATE (the connection broke): the outcome must be looked up, not assumed. */
export class CommitUnknown extends Error { cause: unknown; constructor(cause: unknown) { super('commit outcome unknown'); this.cause = cause; } }

export class Db {
  pool: pg.Pool;
  constructor(url: string, max = 6) {
    this.pool = new pg.Pool({
      // TLS comes from the URL's sslmode, with certificate verification (Codex R7-2). On Render the internal URL is used.
      connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (e) => console.error('[sounding] idle client error', e.message));
  }

  /** A query outside any transaction, as one workspace (or '*' for server-internal maintenance). */
  async q<T = Record<string, unknown>>(ws: string, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(ws, (q) => q<T>(sql, params));
  }

  /**
   * Runs fn in one transaction and commits, unless fn throws (rollback, rethrow). `rollbackOnly` always rolls back and
   * returns fn's result: that is how a simulation discards its writes.
   */
  async tx<T>(ws: string, fn: (q: Q, c: pg.PoolClient) => Promise<T>, o: TxOpts & { rollbackOnly?: boolean } = {}): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    // A connection that dies while checked out emits 'error'; without a listener that would crash the process.
    const onError = () => { broken = true; };
    c.on('error', onError);
    try {
      await c.query(`begin isolation level ${o.isolation ?? 'read committed'}`);
      await c.query(
        `select set_config('snd.ws', $1, true), set_config('snd.capture', $2, true), set_config('snd.action', $3, true),
                set_config('statement_timeout', $4, true), set_config('lock_timeout', $5, true), set_config('idle_in_transaction_session_timeout', '20s', true)`,
        [ws, o.capture ?? '', o.action ?? '', `${o.statementMs ?? 8000}ms`, `${o.lockMs ?? 3000}ms`]);
      const q: Q = async (sql, params = []) => (await c.query(sql, params)).rows;
      const r = await fn(q, c);
      if (o.rollbackOnly) { await c.query('rollback'); return r; }
      if (o.beforeCommit) await o.beforeCommit(c);
      try { await c.query('commit'); await o.afterCommit?.(); } catch (e) {
        // Only an error response from the server is a definite outcome (e.g. serialization failure at commit: rolled back).
        // A transport error (ECONNRESET, a closed socket) may arrive after the server committed (Codex R6-8).
        if (e instanceof pg.DatabaseError) throw e;
        broken = true; throw new CommitUnknown(e);
      }
      return r;
    } catch (e) {
      if (!(e instanceof CommitUnknown)) try { await c.query('rollback'); } catch { broken = true; }
      throw e;
    } finally {
      if (!broken) c.off('error', onError); // a broken client keeps the listener: it may still emit after release
      c.release(broken);
    }
  }

  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(7240531)'); // parallel test processes migrate one at a time
      await c.query(DDL);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }

  /** Whether row-level security actually applies to this connection's role (superusers and BYPASSRLS roles skip it). */
  async rlsEnforced() {
    const [r] = (await this.pool.query(`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`)).rows;
    return !r.bypass;
  }

  close() { return this.pool.end(); }
}

/**
 * A digest of everything that decides what a mutation does: every table in the schema (columns with types and defaults,
 * constraints incl. FK actions, triggers incl. enabled state, RLS policies) and the source of every function in it. A
 * simulation is bound to it; execution refuses if it changed. `uncaptured` lists what would make a measurement
 * incomplete: a business table without its enabled capture trigger, a table outside the journalled set that an FK
 * chain reaches from a business table (its cascaded rows would go unmeasured), and any trigger on a bookkeeping table
 * (execution writes those after verification).
 */
export async function schemaFingerprint(q: Q) {
  const [r] = await q<{ fp: string; capture: string[] }>(`
    with recursive t as (select c.oid, c.relname, c.relname = any($1) as biz from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = current_schema() and c.relkind in ('r', 'p')),
      reach(oid) as (select oid from t where biz
        union select k.conrelid from pg_constraint k join reach on k.confrelid = reach.oid where k.contype = 'f')
    select md5(string_agg(x, E'\n' order by x)) as fp, array(
      select relname || ' (no capture trigger)' from t where biz and not exists (
        select 1 from pg_trigger g where g.tgrelid = t.oid and g.tgname = 'zzz_capture' and g.tgenabled = 'O')
      union all select t.relname || ' (not journalled, but reachable by foreign key)' from t join reach using (oid) where not t.biz
      union all select distinct t.relname || ' (bookkeeping table with a trigger)' from t join pg_trigger g on g.tgrelid = t.oid where not t.biz and not g.tgisinternal
      order by 1) as capture
    from (
      select 'col ' || t.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
        from t join pg_attribute a on a.attrelid = t.oid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attnum > 0 and not a.attisdropped
      union all select 'con ' || t.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) from t join pg_constraint k on k.conrelid = t.oid
      union all select 'trg ' || t.relname || ' ' || g.tgenabled::text || ' ' || pg_get_triggerdef(g.oid) from t join pg_trigger g on g.tgrelid = t.oid where not g.tgisinternal
      union all select 'pol ' || t.relname || ' ' || p.polname || ' ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') from t join pg_policy p on p.polrelid = t.oid
      union all select 'rls ' || c.relname || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity from pg_class c join t on t.oid = c.oid
      union all select 'fn ' || p.oid::regprocedure::text || ' ' || md5(coalesce(p.prosrc, '') || coalesce(p.probin, '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = current_schema() and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    ) s(x)`, [SCHEMA_TABLES]);
  return { fp: r.fp, uncaptured: r.capture ?? [] };
}
