// Before/after, row by row. Deletions show what disappears, updates show only the columns that change, inserts show
// what appears. Rows a policy rule flagged carry its note. "Now" re-reads the live row, so drift is visible.
import { useMemo, useState } from 'react';
import { api, type Effect, type Row, type Simulation } from './api.ts';
import { LABEL, nodesOf } from './Canvas.tsx';

const SKIP = new Set(['id', 'workspace_id']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : ISO.test(String(v)) ? String(v).slice(0, 10) : String(v));
const KEY: Record<string, string[]> = {
  customers: ['name', 'email', 'status', 'last_active_at'], orders: ['status', 'total_cents', 'placed_at'], invoices: ['number', 'status', 'amount_cents'],
  payments: ['amount_cents', 'method', 'captured_at'], shipments: ['status', 'carrier', 'tracking'], subscriptions: ['plan', 'status', 'monthly_cents'],
  support_cases: ['subject', 'status'], addresses: ['kind', 'line1', 'city'], order_lines: ['product_id', 'qty'], outbox: ['topic', 'aggregate', 'status'],
  ledger_entries: ['kind', 'ref', 'amount_cents'], products: ['name', 'reserved'],
};

function cells(e: Effect): { k: string; before?: string; after?: string }[] {
  if (e.op === 'UPDATE') {
    const b = e.before ?? {}, a = e.after ?? {};
    return Object.keys(a).filter((k) => !SKIP.has(k) && fmt(a[k]) !== fmt(b[k])).map((k) => ({ k, before: fmt(b[k]), after: fmt(a[k]) }));
  }
  const r = (e.op === 'DELETE' ? e.before : e.after) ?? {};
  const pick = (KEY[e.tbl] ?? []).filter((k) => k in r);
  const keys = (pick.length ? pick : Object.keys(r).filter((k) => !SKIP.has(k))).slice(0, 4);
  return keys.map((k) => (e.op === 'DELETE' ? { k, before: fmt(r[k]) } : { k, after: fmt(r[k]) }));
}

export function Diff({ sim, selected, onClear }: { sim: Simulation; selected: string | null; onClear: () => void }) {
  const [limit, setLimit] = useState(12);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [live, setLive] = useState<Record<string, Row | null | 'loading'>>({});
  const notes = useMemo(() => {
    const m = new Map<string, { rule: string; note: string; severity: string }[]>();
    for (const f of sim.report.policy.findings) for (const r of f.rows) m.set(`${r.tbl}:${r.id}`, [...(m.get(`${r.tbl}:${r.id}`) ?? []), { rule: f.rule, note: r.note, severity: f.severity }]);
    return m;
  }, [sim]);
  const all = nodesOf(sim);
  const rank = new Map(all.map((n, i) => [`${n.tbl}:${n.op}:${n.depth === 0}`, i]));
  const node = selected ? all.find((n) => n.id === selected) : null;
  const rows = sim.effects.filter((e) => (!node || (e.tbl === node.tbl && e.op === node.op && (e.cause === 'direct') === (node.depth === 0)))
    && (!onlyFlagged || notes.has(`${e.tbl}:${e.id}`)))
    .sort((a, b) => (rank.get(`${a.tbl}:${a.op}:${a.cause === 'direct'}`) ?? 0) - (rank.get(`${b.tbl}:${b.op}:${b.cause === 'direct'}`) ?? 0) || a.seq - b.seq);
  const shown = rows.slice(0, limit);
  async function now(e: Effect) {
    const k = `${e.tbl}:${e.id}`;
    setLive((l) => ({ ...l, [k]: 'loading' }));
    try { const [r] = await api.records(e.tbl, [e.id]); setLive((l) => ({ ...l, [k]: r ?? null })); }
    catch { setLive((l) => ({ ...l, [k]: null })); }
  }
  return (
    <section className="panel diff" aria-labelledby="diff-title">
      <div className="panel-head">
        <h2 id="diff-title">Before → after{node ? <> · {LABEL[node.tbl] ?? node.tbl}</> : null}</h2>
        <div className="row gap">
          <label className="check"><input type="checkbox" checked={onlyFlagged} onChange={(e) => { setOnlyFlagged(e.target.checked); setLimit(12); }} /> Only rows a rule names</label>
          {node ? <button type="button" className="btn ghost sm" onClick={onClear}>All layers</button> : null}
        </div>
      </div>
      <p className="muted">{rows.length.toLocaleString('en-US')} row change{rows.length === 1 ? '' : 's'}{node ? ', in the order the dry run made them' : ', layer by layer from the waterline down'}.</p>
      <ol className="diff-list" role="list">
        {shown.map((e) => {
          const k = `${e.tbl}:${e.id}`, n = notes.get(k), l = live[k];
          return (
            <li key={e.key} className={`diff-row op-${e.op.toLowerCase()}${n?.some((x) => x.severity === 'block') ? ' blocked' : ''}`}>
              <div className="diff-meta">
                <span className={`op-badge op-${e.op.toLowerCase()}`}>{e.tbl === 'outbox' && e.op === 'INSERT' ? 'QUEUE' : e.op}</span>
                <span className="mono">{LABEL[e.tbl] ?? e.tbl} · {e.id}</span>
                <span className="cause">{e.cause.replace('_', ' ')}</span>
                {e.op !== 'INSERT' ? <button type="button" className="btn ghost xs" onClick={() => now(e)} aria-label={`Read ${e.id} as it is now`}>now</button> : null}
              </div>
              <dl className="cells">
                {cells(e).map((c) => (
                  <div key={c.k} className="cell"><dt>{c.k}</dt><dd>{c.before !== undefined ? <del>{c.before}</del> : null}{c.before !== undefined && c.after !== undefined ? <span aria-hidden="true"> → </span> : null}{c.after !== undefined ? <ins>{c.after}</ins> : null}</dd></div>
                ))}
              </dl>
              {n ? <ul className="notes" role="list">{n.map((x, j) => <li key={j} className={`note sev-${x.severity}`}><span className="rule">{x.rule.replace(/_/g, ' ').toLowerCase()}</span> {x.note}</li>)}</ul> : null}
              {l ? <p className="live mono">{l === 'loading' ? 'reading…' : l === null ? 'now: row not found' : `now: ${cells({ ...e, op: 'DELETE', before: l }).map((c) => `${c.k}=${c.before}`).join(' · ')} · version ${String(l._version)}`}</p> : null}
            </li>
          );
        })}
      </ol>
      {rows.length > limit ? <button type="button" className="btn ghost" onClick={() => setLimit((x) => x + 40)}>Show {Math.min(40, rows.length - limit)} more of {rows.length - limit}</button> : null}
    </section>
  );
}
