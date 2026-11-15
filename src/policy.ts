// The risk policy. Deterministic, versioned, and evaluated only over measured effects: it never asks what the agent
// intended, only what the dry run (or the real execution) actually did.
import type { Effect, Row } from './effects.ts';

export const POLICY_VERSION = 'larkspur-2026.11-r1';
export const RETENTION_YEARS = 7;
export const MAX_TARGETS = 200;
export const MAX_EFFECTS = 5000;

export type Rule = 'OPEN_OBLIGATION' | 'FINANCIAL_RETENTION' | 'REFUND_TRIGGERED' | 'LABEL_VOID' | 'TARGET_DRIFT' | 'EMPTY' | 'LIMIT'
  | 'RESTORE_CONFLICT' | 'RESTORE_EXPIRED' | 'COLLATERAL_EDIT' | 'EXTERNAL_MESSAGE' | 'IRREVERSIBLE';
export type Finding = {
  rule: Rule; severity: 'block' | 'warn'; title: string; detail: string;
  /** The target records (customers or orders) this finding is attributed to; the agent narrows scope by excluding them. */
  roots: string[];
  rows: { tbl: string; id: string; note: string }[];
};
export type PolicyResult = { version: string; verdict: 'safe' | 'blocked'; findings: Finding[] };

const RULE_TEXT: Record<Rule, string> = {
  OPEN_OBLIGATION: 'Never erase a customer who still has an open obligation: unpaid invoice, active subscription, undelivered order or open support case.',
  FINANCIAL_RETENTION: `Invoices and payments younger than ${RETENTION_YEARS} years must be retained.`,
  REFUND_TRIGGERED: 'Cancelling must not trigger an automatic refund; captured money needs a finance review.',
  LABEL_VOID: 'Cancelling must not void a shipping label that has already been bought.',
  TARGET_DRIFT: 'The frozen target list must still match the selection it was built from.',
  EMPTY: 'An action must change something.',
  LIMIT: `At most ${MAX_TARGETS} targets and ${MAX_EFFECTS} row changes per action.`,
  RESTORE_CONFLICT: 'A restoration must not overwrite or collide with anything that changed after the original action.',
  RESTORE_EXPIRED: 'Recovery records are kept for a bounded window only.',
  COLLATERAL_EDIT: 'Records outside the target list will be modified.',
  EXTERNAL_MESSAGE: 'Messages to external providers are queued and cannot be recalled once dispatched.',
  IRREVERSIBLE: 'Some effects of the original action have already left this database and cannot be undone.',
};
export const ruleText = (r: Rule) => RULE_TEXT[r];

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const yearsAgo = (iso: unknown, now: number) => (now - Date.parse(String(iso))) / (365.25 * 86_400_000);

/** Maps every effect back to the target record it belongs to, using only before/after images in the effect set. */
export function attribution(effects: Effect[], rootTable: 'customers' | 'orders') {
  const img = (e: Effect) => (e.before ?? e.after)!;
  const parent = new Map<string, string>(); // "tbl:id" -> root id
  const set = (tbl: string, id: string, root: string | undefined) => { if (root) parent.set(`${tbl}:${id}`, root); };
  const order = (e: Effect) => ['orders', 'subscriptions', 'invoices', 'payments', 'shipments', 'order_lines', 'addresses', 'support_cases', 'customers', 'ledger_entries', 'outbox', 'products'].indexOf(e.tbl);
  for (const e of [...effects].sort((a, b) => order(a) - order(b))) {
    const r = img(e);
    if (rootTable === 'customers') {
      if (e.tbl === 'customers') set('customers', e.id, e.cause === 'direct' ? e.id : undefined);
      else if (['orders', 'subscriptions', 'addresses', 'support_cases'].includes(e.tbl)) set(e.tbl, e.id, String(e.before?.customer_id ?? r.customer_id ?? ''));
    } else if (e.tbl === 'orders') set('orders', e.id, e.id);
    if (e.tbl === 'invoices' || e.tbl === 'shipments' || e.tbl === 'order_lines') set(e.tbl, e.id, rootTable === 'orders' ? String(r.order_id) : parent.get(`orders:${r.order_id}`));
    if (e.tbl === 'payments') set(e.tbl, e.id, parent.get(`invoices:${r.invoice_id}`));
  }
  const rootOf = (e: Effect): string | undefined => {
    const r = img(e);
    if (e.tbl === 'outbox') {
      const p = r.payload as Row;
      for (const [k, t] of [['customer', 'customers'], ['subscription', 'subscriptions'], ['shipment', 'shipments'], ['case', 'support_cases'], ['order', 'orders']] as const) {
        if (p?.[k]) { const hit = t === rootTable ? String(p[k]) : parent.get(`${t}:${p[k]}`); if (hit) return hit; }
      }
      return undefined;
    }
    if (e.tbl === 'ledger_entries') return parent.get(`payments:${r.ref}`);
    return parent.get(`${e.tbl}:${e.id}`);
  };
  return rootOf;
}

type Ctx = { template: string; targetIds: string[]; now: number; rootTable: 'customers' | 'orders'; predicateIds?: string[]; restore?: { conflicts: { tbl: string; id: string; reason: string }[]; expired: boolean; irreversible: { id: string; topic: string }[] } };

export function evaluate(effects: Effect[], ctx: Ctx): PolicyResult {
  const findings: Finding[] = [];
  const rootOf = attribution(effects, ctx.rootTable);
  const targets = new Set(ctx.targetIds);
  const add = (rule: Rule, severity: Finding['severity'], hits: { e?: Effect; root?: string; tbl?: string; id?: string; note: string }[], detail: string) => {
    if (!hits.length) return;
    const roots = [...new Set(hits.map((h) => h.root ?? (h.e && rootOf(h.e))).filter((x): x is string => !!x))].sort();
    findings.push({ rule, severity, title: RULE_TEXT[rule], detail, roots, rows: hits.map((h) => ({ tbl: h.tbl ?? h.e!.tbl, id: h.id ?? h.e!.id, note: h.note })) });
  };
  const del = (tbl: string, f: (r: Row) => boolean) => effects.filter((e) => e.op === 'DELETE' && e.tbl === tbl && f(e.before!));

  if (ctx.targetIds.length === 0) add('EMPTY', 'block', [{ tbl: '-', id: '-', note: 'no targets' }], 'The selection matches nothing.');
  if (ctx.targetIds.length > MAX_TARGETS || effects.length > MAX_EFFECTS) add('LIMIT', 'block', [{ tbl: '-', id: '-', note: `${ctx.targetIds.length} targets, ${effects.length} changes` }], 'Split the action into smaller batches.');
  if (ctx.predicateIds) {
    const now = new Set(ctx.predicateIds);
    const gone = ctx.targetIds.filter((id) => !now.has(id)), added = ctx.predicateIds.filter((id) => !targets.has(id));
    if (gone.length) add('TARGET_DRIFT', 'block', gone.map((id) => ({ root: id, tbl: ctx.rootTable, id, note: 'no longer matches the selection' })), `${gone.length} frozen target(s) no longer match; re-plan from the current data.`);
    if (added.length) add('TARGET_DRIFT', 'warn', added.map((id) => ({ tbl: ctx.rootTable, id, note: 'now matches but is not included' })), `${added.length} record(s) newly match the selection and are not in this action.`);
  }

  if (ctx.template === 'purge_inactive_customers') {
    const open: { e: Effect; note: string }[] = [
      ...del('invoices', (r) => r.status === 'open').map((e) => ({ e, note: `unpaid invoice ${e.before!.number}, ${money(e.before!.amount_cents as number)}` })),
      ...del('subscriptions', (r) => r.status === 'active').map((e) => ({ e, note: `active ${e.before!.plan} subscription, ${money(e.before!.monthly_cents as number)}/month` })),
      ...del('shipments', (r) => r.status === 'pending' || r.status === 'in_transit').map((e) => ({ e, note: `${e.before!.status} shipment ${e.before!.tracking} via ${e.before!.carrier}` })),
      ...del('orders', (r) => ['pending_payment', 'processing', 'shipped'].includes(String(r.status))).map((e) => ({ e, note: `${String(e.before!.status).replace('_', ' ')} order ${e.id}` })),
      ...effects.filter((e) => e.tbl === 'support_cases' && e.op === 'UPDATE' && e.before!.status === 'open' && e.after!.customer_id === null)
        .map((e) => ({ e, note: `open case "${e.before!.subject}" would lose its customer` })),
    ];
    add('OPEN_OBLIGATION', 'block', open, `${open.length} open obligation(s) would be erased or orphaned.`);
    const fin = [
      ...del('invoices', (r) => yearsAgo(r.issued_at, ctx.now) < RETENTION_YEARS).map((e) => ({ e, note: `invoice ${e.before!.number} issued ${yearsAgo(e.before!.issued_at, ctx.now).toFixed(1)} years ago` })),
      ...del('payments', (r) => yearsAgo(r.captured_at, ctx.now) < RETENTION_YEARS).map((e) => ({ e, note: `payment ${money(e.before!.amount_cents as number)} captured ${yearsAgo(e.before!.captured_at, ctx.now).toFixed(1)} years ago` })),
    ];
    const cents = fin.filter((f) => f.e.tbl === 'invoices').reduce((s, f) => s + (f.e.before!.amount_cents as number), 0);
    add('FINANCIAL_RETENTION', 'block', fin, `${fin.length} financial record(s) inside the retention period (${money(cents)} invoiced) would be deleted by cascade.`);
  }
  if (ctx.template === 'cancel_stale_orders') {
    const refunds = effects.filter((e) => e.tbl === 'outbox' && e.op === 'INSERT' && e.after!.topic === 'payments.refund.request');
    add('REFUND_TRIGGERED', 'block', refunds.map((e) => ({ e, note: `automatic refund of ${money((e.after!.payload as Row).amount_cents as number)}` })), `${refunds.length} cancellation(s) would refund captured payments.`);
    const labels = effects.filter((e) => e.tbl === 'shipments' && e.op === 'UPDATE' && e.after!.status === 'voided');
    add('LABEL_VOID', 'block', labels.map((e) => ({ e, note: `label ${e.before!.tracking} (${e.before!.carrier}) would be voided` })), `${labels.length} purchased label(s) would be voided.`);
  }
  if (ctx.restore) {
    if (ctx.restore.expired) add('RESTORE_EXPIRED', 'block', [{ tbl: 'executions', id: '-', note: 'recovery window has closed' }], 'The recovery record has expired; there is nothing safe to restore from.');
    add('RESTORE_CONFLICT', 'block', ctx.restore.conflicts.map((c) => ({ tbl: c.tbl, id: c.id, note: c.reason })), `${ctx.restore.conflicts.length} record(s) changed after the original action.`);
    add('IRREVERSIBLE', 'warn', ctx.restore.irreversible.map((x) => ({ tbl: 'outbox', id: x.id, note: `${x.topic} already delivered; a compensating message will be queued` })), 'Already-delivered messages cannot be unsent.');
  }
  const collateral = effects.filter((e) => e.tbl === 'customers' && e.op === 'UPDATE' && ctx.rootTable === 'customers' && !targets.has(e.id));
  add('COLLATERAL_EDIT', 'warn', collateral.map((e) => ({ e, root: e.changed?.includes('referred_by') ? String(e.before!.referred_by) : undefined, note: `${e.before!.status} customer ${e.before!.name}: ${e.changed!.join(', ')} cleared` })), `${collateral.length} customer(s) outside the target list will be modified.`);
  const msgs = effects.filter((e) => e.tbl === 'outbox' && e.op === 'INSERT');
  add('EXTERNAL_MESSAGE', 'warn', msgs.map((e) => ({ e, note: String(e.after!.topic) })), `${msgs.length} message(s) to external providers, held 60 s after commit, then sent.`);

  return { version: POLICY_VERSION, verdict: findings.some((f) => f.severity === 'block') ? 'blocked' : 'safe', findings };
}
