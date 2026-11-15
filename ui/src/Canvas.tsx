// The consequence canvas. Above the waterline: what was asked for. Below it: everything the dry run measured the
// request dragging along, by depth in the foreign-key graph. Each layer is a list of buttons, so it reads and works
// the same with a keyboard, a screen reader and a phone.
import type { Effect, Simulation } from './api.ts';
import { plural } from './api.ts';

const PARENT: Record<string, string> = {
  addresses: 'customers', orders: 'customers', subscriptions: 'customers', support_cases: 'customers',
  order_lines: 'orders', invoices: 'orders', shipments: 'orders', payments: 'invoices', products: 'order_lines', ledger_entries: 'payments',
};
export const LABEL: Record<string, string> = {
  customers: 'customers', addresses: 'addresses', orders: 'orders', order_lines: 'order lines', invoices: 'invoices', payments: 'payments',
  shipments: 'shipments', subscriptions: 'subscriptions', support_cases: 'support cases', products: 'products', ledger_entries: 'ledger entries',
  outbox: 'outgoing messages', settings: 'settings',
};
const VERB: Record<string, string> = { DELETE: 'deleted', UPDATE: 'changed', INSERT: 'inserted' };
const CAUSE: Record<string, string> = { direct: 'requested', cascade: 'cascade', set_null: 'set null', trigger: 'trigger', restore: 'restored with it' };

export type Node = { id: string; tbl: string; op: Effect['op']; n: number; causes: Record<string, number>; flagged: number; depth: number };

function depthOf(tbl: string, root: string): number {
  let d = 0, t: string | undefined = tbl;
  while (t && t !== root && d < 8) { t = PARENT[t]; d++; }
  return t === root ? d : 1;
}

export function nodesOf(sim: Simulation): Node[] {
  const root = sim.report.root_table;
  const flagged = new Map<string, Set<string>>();
  // Only blocking findings flag rows red; warnings are shown in the verdict.
  for (const f of sim.report.policy.findings) if (f.severity === 'block') for (const r of f.rows) {
    if (!flagged.has(r.tbl)) flagged.set(r.tbl, new Set());
    flagged.get(r.tbl)!.add(r.id);
  }
  const by = new Map<string, Node>();
  for (const e of sim.effects) {
    const direct = e.cause === 'direct';
    const k = `${e.tbl}:${e.op}:${direct ? 'd' : 'i'}`;
    const depth = direct ? 0 : e.tbl === 'outbox' ? 99 : e.tbl === root ? 1 : Math.max(1, depthOf(e.tbl, root));
    const node = by.get(k) ?? { id: k, tbl: e.tbl, op: e.op, n: 0, causes: {}, flagged: 0, depth };
    node.n++;
    node.causes[e.cause] = (node.causes[e.cause] ?? 0) + 1;
    if (flagged.get(e.tbl)?.has(e.id)) node.flagged++;
    by.set(k, node);
  }
  return [...by.values()].sort((a, b) => a.depth - b.depth || b.n - a.n);
}

function layerName(d: number, root: string) {
  if (d === 99) return 'Leaving the building';
  if (d === 1) return `Depth 1 · rows that hang off the ${LABEL[root] ?? root}`;
  return `Depth ${d}`;
}

export function Canvas(props: { sim: Simulation; tables: Record<string, number>; selected: string | null; onSelect: (id: string | null) => void; restore: boolean }) {
  const { sim, tables, selected, onSelect } = props;
  const nodes = nodesOf(sim);
  const top = nodes.filter((n) => n.depth === 0);
  const below = nodes.filter((n) => n.depth > 0);
  const layers = [...new Set(below.map((n) => n.depth))].sort((a, b) => a - b);
  const exp = sim.report.expectation;
  const total = sim.effects.length;
  const hidden = total - top.reduce((s, n) => s + n.n, 0);
  const deepest = layers.filter((d) => d !== 99).at(-1) ?? 0;
  let i = 0;
  const btn = (n: Node) => {
    const of = tables[n.tbl];
    const pct = of ? Math.min(100, (n.n / of) * 100) : 100;
    const flagPct = n.n ? (n.flagged / n.n) * pct : 0;
    const isSel = selected === n.id;
    const causeText = Object.entries(n.causes).map(([c, k]) => (Object.keys(n.causes).length > 1 ? `${k} ${CAUSE[c]}` : CAUSE[c])).join(' · ');
    const verb = n.tbl === 'outbox' && n.op === 'INSERT' ? 'queued' : n.op === 'INSERT' && props.restore ? 'restored' : VERB[n.op];
    return (
      <li key={n.id} style={{ '--i': i++ } as React.CSSProperties}>
        <button type="button" className={`node op-${n.op.toLowerCase()}${n.flagged ? ' has-flag' : ''}`} aria-pressed={isSel} onClick={() => onSelect(isSel ? null : n.id)}
          aria-label={`${LABEL[n.tbl] ?? n.tbl}: ${n.n} ${verb}${of ? ` of ${of}` : ''}, ${causeText}${n.flagged ? `, ${n.flagged} blocked by policy` : ''}. Show rows.`}>
          <span className="node-top">
            <span className="node-name">{LABEL[n.tbl] ?? n.tbl}</span>
            <span className="node-cause">{causeText}</span>
          </span>
          <span className="node-count"><strong>{n.n.toLocaleString('en-US')}</strong> {verb}{of ? <span className="muted"> of {of.toLocaleString('en-US')}</span> : null}</span>
          <span className="bar" aria-hidden="true"><span className="bar-fill" style={{ width: `${Math.max(pct, 2)}%` }} />{n.flagged ? <span className="bar-flag" style={{ width: `${Math.max(flagPct, 2)}%` }} /> : null}</span>
          {n.flagged ? <span className="node-flag">{n.flagged} blocked</span> : null}
        </button>
      </li>
    );
  };
  return (
    <figure className="canvas" aria-labelledby="canvas-title">
      <figcaption className="canvas-head">
        <h2 id="canvas-title">Consequences</h2>
        <p className="muted">Measured in a rollback-only transaction against this workspace's data. Select a layer to see its rows.</p>
      </figcaption>
      <div className="air">
        <p className="layer-label">Asked for · the agent's own projection: <span className="mono">{exp.statement}</span></p>
        <ul className="layer" role="list">{top.map(btn)}</ul>
      </div>
      <div className="waterline" role="separator" aria-label={`Waterline: ${hidden} further row changes below`}>
        <svg viewBox="0 0 400 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 6 Q 10 0 20 6 T 40 6 T 60 6 T 80 6 T 100 6 T 120 6 T 140 6 T 160 6 T 180 6 T 200 6 T 220 6 T 240 6 T 260 6 T 280 6 T 300 6 T 320 6 T 340 6 T 360 6 T 380 6 T 400 6" /></svg>
        <span className="waterline-text">{hidden > 0 ? <>below the waterline: <strong>{plural(hidden, 'more row change')}</strong> {props.restore ? 'restored along with them' : 'nobody typed'}</> : 'nothing below the waterline'}</span>
      </div>
      <div className="sea">
        <div className="sounding-line" aria-hidden="true" style={{ '--depth': layers.length } as React.CSSProperties}><span className="lead" /></div>
        {layers.map((d) => (
          <section key={d} className={`depth${d === 99 ? ' depth-out' : ''}`} aria-label={layerName(d, sim.report.root_table)}>
            <p className="layer-label">{layerName(d, sim.report.root_table)}{d === 99 ? <span className="muted"> · written by triggers, sent by the dispatcher after a hold</span> : null}</p>
            <ul className="layer" role="list">{below.filter((n) => n.depth === d).map(btn)}</ul>
          </section>
        ))}
        <p className="sounding-reading mono">{plural(total, 'row change')} · {deepest} level{deepest === 1 ? '' : 's'} deep · {Object.keys(sim.report.summary.tables).length} tables</p>
      </div>
    </figure>
  );
}
