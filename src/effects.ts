// Turning the capture journal into effects, and comparing two effect sets exactly. Nothing here predicts: every effect
// is a row change PostgreSQL actually made inside a transaction.
import { createHash } from 'node:crypto';
import { TABLES, VOLATILE, type Table } from './schema.ts';

export type Row = Record<string, unknown>;
export type Op = 'INSERT' | 'UPDATE' | 'DELETE';
/** How the change came about, read from the journal: the statement the action ran, an FK action, or trigger logic. */
export type Cause = 'direct' | 'cascade' | 'set_null' | 'trigger' | 'restore';
export type Effect = { key: string; seq: number; tbl: Table; op: Op; id: string; cause: Cause; before?: Row; after?: Row; changed?: string[] };
export type Journal = { seq: number; tbl: string; op: Op; old_row: Row | null; new_row: Row | null }[];
/** `explicit`: every other journalled row was also written by the action's own statements (a restoration), not by a cascade or trigger. */
export type Direct = { tbl: Table; op: Op; ids: Set<string>; explicit?: boolean };

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(',')}}`;
}
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A row image without the columns that are the same for every row (workspace) or clock-derived (volatile). */
export function stable(tbl: Table, row: Row | null | undefined): Row | undefined {
  if (!row) return undefined;
  const drop = new Set(['workspace_id', ...(VOLATILE[tbl] ?? [])]);
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)));
}

export function effectsFrom(journal: Journal, direct: Direct): Effect[] {
  const seen = new Map<string, number>();
  return journal.map((j) => {
    const tbl = j.tbl as Table;
    if (!TABLES.includes(tbl)) throw new Error(`journal row for unknown table ${j.tbl}`);
    const before = stable(tbl, j.old_row), after = stable(tbl, j.new_row);
    const id = String((j.old_row ?? j.new_row)!.id);
    const changed = j.op === 'UPDATE' ? Object.keys(after!).filter((k) => canonical(before![k]) !== canonical(after![k])) : undefined;
    let cause: Cause;
    if (tbl === direct.tbl && j.op === direct.op && direct.ids.has(id)) cause = 'direct';
    else if (direct.explicit && tbl !== 'outbox') cause = 'restore';
    else if (j.op === 'DELETE') cause = 'cascade';
    else if (j.op === 'UPDATE' && changed!.length > 0 && changed!.every((k) => after![k] === null)) cause = 'set_null';
    else cause = 'trigger';
    // One row can change more than once in a transaction; each change is its own effect.
    const base = `${tbl}:${id}:${j.op}`, n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, seq: j.seq, tbl, op: j.op, id, cause, before, after, changed };
  });
}

const fingerprintOf = (e: Effect) => canonical({ k: e.key, b: e.before ?? null, a: e.after ?? null });
/** The digest an approval binds to: order-independent, over every effect's key and stable before/after images. */
export const effectDigest = (effects: Effect[]) => sha(effects.map(fingerprintOf).sort().join('\n'));

export type Comparison = { match: boolean; unexpected: Effect[]; missing: Effect[]; changed: { approved: Effect; actual: Effect; columns: string[] }[] };
/** Exact comparison. Tolerance: none, apart from the volatile columns listed in schema.ts. */
export function compare(approved: Effect[], actual: Effect[]): Comparison {
  const a = new Map(approved.map((e) => [e.key, e])), b = new Map(actual.map((e) => [e.key, e]));
  const unexpected = actual.filter((e) => !a.has(e.key)), missing = approved.filter((e) => !b.has(e.key));
  const changed: Comparison['changed'] = [];
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y || fingerprintOf(x) === fingerprintOf(y)) continue;
    const cols = new Set([...Object.keys(x.before ?? {}), ...Object.keys(x.after ?? {}), ...Object.keys(y.before ?? {}), ...Object.keys(y.after ?? {})]);
    const columns = [...cols].filter((c) => canonical(x.before?.[c]) !== canonical(y.before?.[c]) || canonical(x.after?.[c]) !== canonical(y.after?.[c]));
    changed.push({ approved: x, actual: y, columns });
  }
  return { match: !unexpected.length && !missing.length && !changed.length, unexpected, missing, changed };
}

export type TableSummary = { deleted: number; updated: number; inserted: number };
export function summarize(effects: Effect[]) {
  const by: Partial<Record<Table, TableSummary>> = {};
  for (const e of effects) {
    const s = (by[e.tbl] ??= { deleted: 0, updated: 0, inserted: 0 });
    if (e.op === 'DELETE') s.deleted++; else if (e.op === 'UPDATE') s.updated++; else s.inserted++;
  }
  const causes: Record<Cause, number> = { direct: 0, cascade: 0, set_null: 0, trigger: 0, restore: 0 };
  for (const e of effects) causes[e.cause]++;
  return { tables: by, causes, total: effects.length };
}
