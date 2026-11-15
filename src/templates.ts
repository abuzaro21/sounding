// The only mutations SOUNDING can perform. Each template resolves a bounded selection to an explicit, frozen list of ids,
// and has exactly one apply() that both the dry run and the real execution call. No caller can supply SQL.
import type { Q } from './db.ts';
import { canonical, stable, type Direct, type Journal, type Row } from './effects.ts';
import { TABLES, type Table } from './schema.ts';

export type TemplateName = 'purge_inactive_customers' | 'cancel_stale_orders' | 'restore_execution';
export type Spec = {
  template: TemplateName;
  params: { months?: number; days?: number; execution_id?: string };
  exclude: string[];
  /** Frozen at planning time. Execution mutates exactly these ids, never "whatever matches now". */
  target_ids: string[];
  mode: 'recoverable_delete' | 'recoverable_update' | 'compensating_restore';
};
export type RestoreCtx = { conflicts: { tbl: string; id: string; reason: string }[]; expired: boolean; irreversible: { id: string; topic: string }[] };
export type ApplyResult = { restore?: RestoreCtx };
export type Original = { spec: Spec; journal: Journal | null; status: string; recovery_status: string | null; expires: number | null };

export class PlanError extends Error {}

export const LIMITS = { months: [6, 120], days: [3, 365] } as const;
const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };
const tableOf = (t: string): Table => { if (!TABLES.includes(t as Table)) throw new Error(`bad table ${t}`); return t as Table; };

async function lockIds(q: Q, ws: string, tbl: Table, ids: string[]) {
  await q(`select id from ${tbl} where workspace_id = $1 and id = any($2) order by id for update`, [ws, ids]);
}

export const TEMPLATES = {
  purge_inactive_customers: {
    rootTable: 'customers' as const,
    title: (s: Spec) => `Delete ${s.target_ids.length} customer accounts inactive for more than ${s.params.months} months`,
    async resolve(q: Q, ws: string, s: Pick<Spec, 'params' | 'exclude'>) {
      const m = s.params.months!;
      if (!Number.isInteger(m) || m < LIMITS.months[0] || m > LIMITS.months[1]) throw new PlanError(`months must be a whole number from ${LIMITS.months[0]} to ${LIMITS.months[1]}.`);
      return (await q<{ id: string }>(
        `select id from customers where workspace_id = $1 and status = 'inactive' and last_active_at < now() - make_interval(months => $2) and not (id = any($3)) order by id`,
        [ws, m, s.exclude])).map((r) => r.id);
    },
    direct: (s: Spec): Direct => ({ tbl: 'customers', op: 'DELETE', ids: new Set(s.target_ids) }),
    lock: (q: Q, ws: string, s: Spec) => lockIds(q, ws, 'customers', s.target_ids),
    async apply(q: Q, ws: string, s: Spec): Promise<ApplyResult> {
      await q(`delete from customers where workspace_id = $1 and id = any($2)`, [ws, s.target_ids]);
      return {};
    },
  },
  cancel_stale_orders: {
    rootTable: 'orders' as const,
    title: (s: Spec) => `Cancel ${s.target_ids.length} orders unpaid for more than ${s.params.days} days`,
    async resolve(q: Q, ws: string, s: Pick<Spec, 'params' | 'exclude'>) {
      const d = s.params.days!;
      if (!Number.isInteger(d) || d < LIMITS.days[0] || d > LIMITS.days[1]) throw new PlanError(`days must be a whole number from ${LIMITS.days[0]} to ${LIMITS.days[1]}.`);
      return (await q<{ id: string }>(
        `select id from orders where workspace_id = $1 and status = 'pending_payment' and placed_at < now() - make_interval(days => $2) and not (id = any($3)) order by id`,
        [ws, d, s.exclude])).map((r) => r.id);
    },
    direct: (s: Spec): Direct => ({ tbl: 'orders', op: 'UPDATE', ids: new Set(s.target_ids) }),
    lock: (q: Q, ws: string, s: Spec) => lockIds(q, ws, 'orders', s.target_ids),
    async apply(q: Q, ws: string, s: Spec): Promise<ApplyResult> {
      await q(`update orders set status = 'cancelled' where workspace_id = $1 and id = any($2) and status = 'pending_payment'`, [ws, s.target_ids]);
      return {};
    },
  },
} as const;

/** Restoration: the inverse of a committed execution, built from the before/after images its journal recorded. */
export const RESTORE = {
  title: (o: Original) => `Restore what execution ${o.spec.template === 'purge_inactive_customers' ? 'deleted' : 'changed'}: ${o.spec.target_ids.length} ${TEMPLATES[o.spec.template as keyof typeof TEMPLATES].rootTable}`,
  direct(o: Original): Direct {
    const t = TEMPLATES[o.spec.template as keyof typeof TEMPLATES];
    return { tbl: t.rootTable, op: o.spec.template === 'purge_inactive_customers' ? 'INSERT' : 'UPDATE', ids: new Set(o.spec.target_ids), explicit: true };
  },
  plan(o: Original) {
    const j = o.journal ?? [];
    const rank = (t: string) => TABLES.indexOf(t as Table);
    const deletes = j.filter((x) => x.op === 'DELETE').sort((a, b) => rank(a.tbl) - rank(b.tbl) || a.seq - b.seq);
    const updates = new Map<string, { tbl: Table; id: string; first: Row; last: Row }>();
    for (const x of j.filter((y) => y.op === 'UPDATE')) {
      const k = `${x.tbl}:${x.old_row!.id}`, u = updates.get(k);
      if (u) u.last = x.new_row!; else updates.set(k, { tbl: tableOf(x.tbl), id: String(x.old_row!.id), first: x.old_row!, last: x.new_row! });
    }
    const inserts = j.filter((x) => x.op === 'INSERT');
    return { deletes, updates: [...updates.values()], inserts };
  },
  async lock(q: Q, ws: string, o: Original) {
    const p = RESTORE.plan(o);
    const by = new Map<Table, string[]>();
    for (const u of p.updates) by.set(u.tbl, [...(by.get(u.tbl) ?? []), u.id]);
    for (const x of p.inserts) by.set(tableOf(x.tbl), [...(by.get(tableOf(x.tbl)) ?? []), String(x.new_row!.id)]);
    for (const t of TABLES) if (by.has(t)) await lockIds(q, ws, t, by.get(t)!.sort());
  },
  async apply(q: Q, ws: string, o: Original, now = Date.now()): Promise<ApplyResult> {
    const ctx: RestoreCtx = { conflicts: [], expired: false, irreversible: [] };
    if (o.status !== 'committed' || !o.journal || o.recovery_status !== 'available' || (o.expires ?? 0) < now) return { restore: { ...ctx, expired: true } };
    const p = RESTORE.plan(o);
    const current = async (tbl: string, id: string) => (await q<Row>(`select to_jsonb(t) as r from ${tableOf(tbl)} t where workspace_id = $1 and id = $2`, [ws, id]))[0]?.r as Row | undefined;
    // 1. Conflicts. Any one blocks the whole restoration; nothing is half-restored.
    for (const d of p.deletes) {
      if (await current(d.tbl, String(d.old_row!.id))) ctx.conflicts.push({ tbl: d.tbl, id: String(d.old_row!.id), reason: 'the id has been reused since' });
      if (d.tbl === 'customers') {
        const [hit] = await q<{ id: string }>(`select id from customers where workspace_id = $1 and email = $2`, [ws, d.old_row!.email]);
        if (hit) ctx.conflicts.push({ tbl: 'customers', id: String(d.old_row!.id), reason: `email now belongs to ${hit.id}` });
      }
    }
    for (const u of p.updates) {
      const cur = await current(u.tbl, u.id);
      if (!cur) ctx.conflicts.push({ tbl: u.tbl, id: u.id, reason: 'deleted since' });
      else if (canonical(stable(u.tbl, cur)) !== canonical(stable(u.tbl, u.last))) ctx.conflicts.push({ tbl: u.tbl, id: u.id, reason: 'changed since' });
    }
    const outbox: { row: Row; cur: Row }[] = [];
    for (const x of p.inserts) {
      const id = String(x.new_row!.id), cur = await current(x.tbl, id);
      if (!cur) { ctx.conflicts.push({ tbl: x.tbl, id, reason: 'deleted since' }); continue; }
      if (x.tbl === 'outbox') {
        // Only the dispatcher's status transition is expected; any other change to the message is a conflict (Codex R6-11).
        const content = (r: Row) => canonical({ ...stable('outbox', r), status: undefined });
        if (content(cur) !== content(x.new_row!)) { ctx.conflicts.push({ tbl: 'outbox', id, reason: 'message changed since' }); continue; }
        outbox.push({ row: x.new_row!, cur }); if (cur.status === 'dispatched') ctx.irreversible.push({ id, topic: String(cur.topic) });
      }
      else if (canonical(stable(tableOf(x.tbl), cur)) !== canonical(stable(tableOf(x.tbl), x.new_row))) ctx.conflicts.push({ tbl: x.tbl, id, reason: 'changed since' });
    }
    if (ctx.conflicts.length) return { restore: ctx };
    // 2. Re-insert deleted rows parent-first, one statement per table: an immediate FK is checked at the end of the
    //    statement, so customers that referred one another, even in a cycle, go back together (Codex R6-9).
    for (const t of TABLES) {
      const rows = p.deletes.filter((d) => d.tbl === t).map((d) => d.old_row);
      if (rows.length) await q(`insert into ${t} select * from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows)]);
    }
    // 3. Put updated rows back to their first before-image.
    for (const u of p.updates) {
      const cols = Object.keys(u.first).filter((c) => c !== 'workspace_id' && c !== 'id').map(ident);
      await q(`update ${u.tbl} set (${cols.join(', ')}) = (select ${cols.join(', ')} from jsonb_populate_record(null::${u.tbl}, $3::jsonb)) where workspace_id = $1 and id = $2`,
        [ws, u.id, JSON.stringify(u.first)]);
    }
    // 4. Rows the action created: queued messages are cancelled for real; delivered ones get a compensating message;
    //    ledger entries are never deleted, they get a counter-entry.
    for (const { row, cur } of outbox) {
      if (cur.status === 'pending') await q(`update outbox set status = 'cancelled' where workspace_id = $1 and id = $2`, [ws, row.id]);
      else if (cur.status === 'dispatched') await q(`select snd_emit($1, $2, $3, $4::jsonb)`, [ws, `${row.topic}.compensate`, row.aggregate, JSON.stringify({ compensates: row.id, ...(row.payload as Row) })]);
    }
    for (const x of p.inserts.filter((y) => y.tbl === 'ledger_entries')) {
      await q(`insert into ledger_entries (workspace_id, id, kind, ref, amount_cents) values ($1, snd_id('le', $2), 'reversal_reinstated', $3, $4)`, [ws, `${x.new_row!.id}|undo`, x.new_row!.ref, -(x.new_row!.amount_cents as number)]);
    }
    for (const x of p.inserts.filter((y) => y.tbl !== 'outbox' && y.tbl !== 'ledger_entries')) {
      await q(`delete from ${tableOf(x.tbl)} where workspace_id = $1 and id = $2`, [ws, x.new_row!.id]);
    }
    return { restore: ctx };
  },
};
