import { useEffect, useRef, useState } from 'react';
import { money, plural, short, type Action, type Approval, type AuditLog, type Execution, type Finding, type Simulation, type State } from './api.ts';
import { LABEL } from './Canvas.tsx';

export const useNow = (ms = 1000) => {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const h = setInterval(() => setT(Date.now()), ms); return () => clearInterval(h); }, [ms]);
  return t;
};
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
export const isRestore = (a: Action) => a.spec.template === 'restore_execution';

// ---------- the proposal ----------
export function Proposal({ action, sim, excluded, onToggle, editing }: { action: Action; sim: Simulation | null; excluded: Set<string>; onToggle: (id: string) => void; editing: boolean }) {
  const t = sim?.report.targets ?? [];
  const p = action.spec.params;
  return (
    <section className="panel" aria-labelledby="prop-title">
      <div className="panel-head">
        <h2 id="prop-title">Proposal</h2>
        <span className="chip">{action.origin.startsWith('agent') ? action.origin : 'operator'}</span>
      </div>
      <p className="intent">{isRestore(action) ? `Restore what execution ${p.execution_id} deleted and changed` : action.intent.startsWith('purge_') || action.intent.startsWith('cancel_') ? 'Revised plan' : `“${action.intent}”`}</p>
      {action.rationale ? <p className="rationale">{action.rationale}</p> : null}
      <dl className="kv">
        <div><dt>Action</dt><dd className="mono">{action.spec.template}</dd></div>
        {p.months ? <div><dt>Inactive for</dt><dd>more than {p.months} months</dd></div> : null}
        {p.days ? <div><dt>Unpaid for</dt><dd>more than {p.days} days</dd></div> : null}
        <div><dt>Targets</dt><dd>{action.spec.target_ids.length}{action.spec.exclude.length ? <span className="muted"> · {action.spec.exclude.length} excluded</span> : null}</dd></div>
        <div><dt>Agent expects</dt><dd className="mono">{action.expectation.statement}</dd></div>
        <div><dt>Spec</dt><dd className="mono" title={action.spec_hash}>{short(action.spec_hash, 12)}</dd></div>
      </dl>
      {t.length ? (
        <details className="targets" open={editing}>
          <summary>{editing ? 'Untick the targets to leave out' : `The ${t.length} targets`}</summary>
          <ul role="list">
            {t.map((x) => (
              <li key={x.id} className={x.blocked_by.length ? 'blocked' : ''}>
                {editing ? <input type="checkbox" checked={!excluded.has(x.id)} onChange={() => onToggle(x.id)} aria-label={`Include ${x.name} (${x.id})`} /> : null}
                <span className="t-name">{x.name}</span>
                <span className="mono muted">{x.id}</span>
                <span className="muted">{x.total_cents !== undefined ? `${money(x.total_cents)} · placed ${when(x.at)}` : `last active ${when(x.at)}`}</span>
                {x.blocked_by.map((r) => <span key={r} className="chip danger">{r.replace(/_/g, ' ').toLowerCase()}</span>)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// ---------- the verdict ----------
export function Verdict({ sim, rules }: { sim: Simulation; rules: Record<string, string> }) {
  const r = sim.report, blocks = r.policy.findings.filter((f) => f.severity === 'block'), warns = r.policy.findings.filter((f) => f.severity === 'warn');
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, [sim.id]);
  const ratio = r.expectation.rows ? sim.effects.length / r.expectation.rows : 0;
  const d = r.durable;
  return (
    <section className={`panel verdict v-${sim.verdict}`} aria-labelledby="verdict-title">
      <h2 id="verdict-title" tabIndex={-1} ref={ref}>
        <span className="verdict-mark" aria-hidden="true">{sim.verdict === 'safe' ? '✓' : '✕'}</span>
        {sim.verdict === 'safe' ? 'Safe to approve' : 'Blocked'}
        <span className="verdict-sub">{blocks.length ? plural(blocks.length, 'policy violation') : 'no policy violations'}{warns.length ? ` · ${plural(warns.length, 'warning')}` : ''}</span>
      </h2>
      <p className="gap-callout">
        The agent expected <strong>{plural(r.expectation.rows, 'row')}</strong> in {LABEL[r.expectation.table] ?? r.expectation.table}. The dry run measured{' '}
        <strong>{plural(sim.effects.length, 'row change')}</strong> in {plural(Object.keys(r.summary.tables).length, 'table')}{ratio > 1.05 ? <> ({ratio.toFixed(1)}× what it predicted)</> : null}.
      </p>
      <ul className="findings" role="list">
        {[...blocks, ...warns].map((f) => <FindingItem key={f.rule} f={f} rule={rules[f.rule]} />)}
      </ul>
      <details className="proof">
        <summary>Proof the dry run left nothing behind</summary>
        <ul role="list" className="mono small">
          <li>{d.journal_rows_in_dry_run} rows really changed inside the dry run ({r.isolation}, {r.ms} ms), then rolled back</li>
          <li>state digest before {short(d.state_before)} · after {short(d.state_after)} · {d.unchanged ? 'identical' : 'DIFFERENT'}</li>
          <li>journal rows left after rollback: {d.journal_residue_after_rollback}</li>
          <li>messages delivered to providers: {d.deliveries_before} → {d.deliveries_after}</li>
          <li>policy {r.policy.version} · effect digest {short(sim.effect_digest, 12)}</li>
        </ul>
      </details>
      {r.modeled.length ? (
        <details className="modeled">
          <summary>Outside this database: {plural(r.modeled.reduce((n, m) => n + m.count, 0), 'message')} to {plural(r.modeled.length, 'provider')}</summary>
          <ul role="list">{r.modeled.map((m) => <li key={m.topic}><strong>{m.count} × {m.provider}</strong> <span className="mono muted">{m.topic}</span><br />{m.consequence}</li>)}</ul>
          <p className="muted small">These are the shop's documented provider contracts, not observations. Messages wait {r.modeled[0].hold_s} s in the outbox before dispatch.</p>
        </details>
      ) : null}
      <details className="unknown">
        <summary>What SOUNDING cannot see</summary>
        <ul role="list">{r.unknown.map((u) => <li key={u}>{u}</li>)}</ul>
      </details>
    </section>
  );
}
function FindingItem({ f, rule }: { f: Finding; rule?: string }) {
  return (
    <li className={`finding sev-${f.severity}`}>
      <details>
        <summary>
          <span className={`sev sev-${f.severity}`}>{f.severity === 'block' ? 'Blocks' : 'Warns'}</span>
          <span className="f-title">{f.title}</span>
          <span className="f-count muted">{plural(f.roots.length, 'target')} · {plural(f.rows.length, 'row')}</span>
        </summary>
        <p>{f.detail}</p>
        {rule && rule !== f.title ? <p className="muted small">Rule {f.rule}: {rule}</p> : null}
        <ul role="list" className="f-rows">
          {f.rows.slice(0, 12).map((r) => <li key={`${r.tbl}:${r.id}`}><span className="mono">{r.id}</span> {r.note}</li>)}
          {f.rows.length > 12 ? <li className="muted">and {f.rows.length - 12} more (see Before → after, “Only rows a rule names”)</li> : null}
        </ul>
      </details>
    </li>
  );
}

// ---------- the decision ----------
type DecisionProps = {
  action: Action; sim: Simulation | null; approval: Approval | null; busy: string | null; editing: boolean; months: number | ''; setMonths: (n: number | '') => void;
  onSimulate: () => void; onRevise: () => void; onApprove: () => void; onReject: () => void; onExecute: () => void; onEdit: () => void; onApplyEdit: () => void; onCancelEdit: () => void;
};
export function Decision(p: DecisionProps) {
  const now = useNow();
  const { action, sim, approval, busy } = p;
  const restore = isRestore(action);
  const isDays = action.spec.template === 'cancel_stale_orders';
  if (p.editing) {
    return (
      <section className="panel decision" aria-labelledby="dec-title">
        <h2 id="dec-title">Change the scope</h2>
        <p className="muted">A changed scope is a new action: it needs its own simulation and approval. The current one is withdrawn.</p>
        <label className="field">{isDays ? 'Unpaid for more than (days, 3–365)' : 'Inactive for more than (months, 6–120)'}
          <input type="number" inputMode="numeric" min={isDays ? 3 : 6} max={isDays ? 365 : 120} value={p.months} onChange={(e) => p.setMonths(e.target.value === '' ? '' : Number(e.target.value))} />
        </label>
        <p className="muted small">Untick targets in the proposal to leave them out.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={p.onApplyEdit} disabled={!!busy}>Propose this scope</button>
          <button type="button" className="btn ghost" onClick={p.onCancelEdit} disabled={!!busy}>Cancel</button>
        </div>
      </section>
    );
  }
  if (approval) {
    const left = Date.parse(approval.expires_at) - now;
    const b = approval.binding;
    return (
      <section className="panel decision bound" aria-labelledby="dec-title">
        <h2 id="dec-title">Approved, not yet executed</h2>
        <p>This approval is a binding, not a yes. It is valid once, for this browser session, for <strong>{clock(left)}</strong>.</p>
        <dl className="kv binding">
          <div><dt>Operator</dt><dd className="mono">{String(b.operator)}</dd></div>
          <div><dt>Simulation</dt><dd className="mono">{String(b.simulation_id)}</dd></div>
          <div><dt>Effect digest</dt><dd className="mono">{short(String(b.effect_digest), 16)} · {b.effects} changes</dd></div>
          <div><dt>Spec</dt><dd className="mono">{short(String(b.spec_hash), 16)}</dd></div>
          <div><dt>Row versions</dt><dd className="mono">{short(String(b.row_versions), 16)}</dd></div>
          <div><dt>Schema</dt><dd className="mono">{short(String(b.schema_fp), 16)}</dd></div>
          <div><dt>Policy</dt><dd className="mono">{String(b.policy_version)}</dd></div>
          <div><dt>One-time nonce</dt><dd className="mono">sha {short(String(b.nonce_hash), 16)}</dd></div>
        </dl>
        <p className="muted small">At execution, the same transaction re-locks the targets, re-applies the change and compares every row change with this digest. Any difference rolls back before commit.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={p.onExecute} disabled={!!busy || left <= 0}>{busy === 'execute' ? 'Executing and verifying…' : left <= 0 ? 'Approval expired' : 'Execute'}</button>
        </div>
      </section>
    );
  }
  if (!sim) {
    return (
      <section className="panel decision" aria-labelledby="dec-title">
        <h2 id="dec-title">Nothing has changed yet</h2>
        <p>{restore ? 'Restoring is a change too. It is simulated and approved like any other.' : 'The plan has not touched the data. Simulate it to measure what it would really do.'}</p>
        <div className="actions"><button type="button" className="btn primary" onClick={p.onSimulate} disabled={!!busy}>{busy === 'simulate' ? 'Simulating…' : 'Simulate'}</button></div>
      </section>
    );
  }
  const stale = now - Date.parse(sim.created_at) > 10 * 60_000;
  return (
    <section className="panel decision" aria-labelledby="dec-title">
      <h2 id="dec-title">Decide</h2>
      {sim.verdict === 'blocked'
        ? <p>This plan cannot be approved. {restore ? 'Restoration is all-or-nothing: resolve the conflicts first.' : 'Narrow it and simulate again.'}</p>
        : stale ? <p>This simulation is older than 10 minutes. Simulate again against the current data.</p>
        : <p>Approving binds to exactly these <strong>{plural(sim.effects.length, 'row change')}</strong> (digest <span className="mono">{short(sim.effect_digest)}</span>). Nothing else can run under it.</p>}
      <div className="actions">
        {sim.verdict === 'blocked' && !restore ? <button type="button" className="btn primary" onClick={p.onRevise} disabled={!!busy}>{busy === 'revise' ? 'Narrowing…' : 'Let the agent narrow it'}</button> : null}
        {sim.verdict === 'safe' && !stale ? <button type="button" className="btn primary" onClick={p.onApprove} disabled={!!busy}>{busy === 'approve' ? 'Binding…' : `Approve ${sim.effects.length} changes`}</button> : null}
        {stale || sim.verdict === 'blocked' && restore ? <button type="button" className="btn" onClick={p.onSimulate} disabled={!!busy}>Simulate again</button> : null}
        {!restore ? <button type="button" className="btn" onClick={p.onEdit} disabled={!!busy}>Change scope</button> : null}
        <button type="button" className="btn ghost" onClick={p.onReject} disabled={!!busy}>Reject</button>
      </div>
    </section>
  );
}

// ---------- the receipt ----------
export function ReceiptPanel({ exec, onRestore, onRetry, busy }: { exec: Execution; onRestore: () => void; onRetry: () => void; busy: string | null }) {
  const r = exec.receipt;
  const now = useNow(15000);
  const ok = exec.status === 'committed';
  const recoverable = exec.recovery_status === 'available' && exec.recovery_expires_at && Date.parse(exec.recovery_expires_at) > now;
  return (
    <section className={`panel receipt r-${exec.status}`} aria-labelledby="rc-title">
      <h2 id="rc-title">{ok ? 'Committed and verified' : exec.status === 'refused' ? 'Refused: nothing ran' : 'Rolled back: nothing changed'}</h2>
      <p>{ok ? `${r.effects ?? ''} row changes committed, identical to the approved simulation.` : r.reason}</p>
      <ol className="checks" role="list">
        {(r.checks ?? []).map((c) => <li key={c.name} className={c.ok ? 'ok' : 'bad'}><span aria-hidden="true">{c.ok ? '✓' : '✕'}</span> <strong>{c.name}</strong> <span className="muted">{c.detail}</span></li>)}
      </ol>
      <dl className="kv">
        <div><dt>Execution</dt><dd className="mono">{exec.id}</dd></div>
        {r.pre_state ? <div><dt>State before</dt><dd className="mono">{short(r.pre_state, 16)}</dd></div> : null}
        {r.post_state ? <div><dt>State after</dt><dd className="mono">{short(r.post_state, 16)}{!ok && r.state_restored ? ' · identical' : ''}</dd></div> : null}
        {r.intact ? <div><dt>Rows re-read</dt><dd>{r.intact.intact} of {r.intact.checked} intact</dd></div> : null}
        {r.journal_residue !== undefined ? <div><dt>Journal residue</dt><dd>{r.journal_residue}</dd></div> : null}
        <div><dt>Isolation</dt><dd>{r.isolation ?? '—'}</dd></div>
      </dl>
      {ok && exec.recovery_status ? (
        <div className="recovery">
          <h3>Recovery</h3>
          {exec.recovery_status === 'restored' ? <p>Restored by a later, separately approved action.</p>
            : recoverable ? <><p>The exact rows this removed and changed are kept until <strong>{time(exec.recovery_expires_at!)}</strong> (24 h), then deleted. Restoring is simulated and approved like any change; messages already delivered cannot be unsent.</p>
              <button type="button" className="btn" onClick={onRestore} disabled={!!busy}>{busy === 'restore' ? 'Planning…' : 'Plan a restoration'}</button></>
            : <p>The recovery copy has expired and was deleted.</p>}
        </div>
      ) : null}
      {!ok ? <div className="actions"><button type="button" className="btn primary" onClick={onRetry} disabled={!!busy}>Simulate again on current data</button></div> : null}
    </section>
  );
}

// ---------- the incident overlay ----------
export function Incident({ exec, onClose, onRetry }: { exec: Execution; onClose: () => void; onRetry: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  const r = exec.receipt, c = r.comparison;
  const failed = (r.checks ?? []).filter((x) => !x.ok);
  return (
    <dialog ref={ref} className="incident" aria-labelledby="inc-title" onClose={onClose} onCancel={onClose}>
      <p className="eyebrow">{exec.status === 'refused' ? 'Refused before any change' : 'Stopped inside the transaction'}</p>
      <h2 id="inc-title">{exec.status === 'refused' ? 'The world moved after approval' : 'Reality differed from the approved simulation'}</h2>
      {exec.status === 'refused' ? <p>{r.reason}</p> : null}
      {failed.length ? <ul role="list" className="checks">{failed.map((x) => <li key={x.name} className="bad"><span aria-hidden="true">✕</span> <strong>{x.name}</strong> <span>{x.detail}</span></li>)}</ul> : null}
      {c && c.unexpected.length ? (
        <>
          <h3>Not in what you approved</h3>
          <ul role="list" className="inc-rows">
            {c.unexpected.slice(0, 8).map((e) => <li key={e.key}><span className={`op-badge op-${e.op.toLowerCase()}`}>{e.op}</span> <span className="mono">{LABEL[e.tbl] ?? e.tbl} · {e.id}</span> <span className="muted">{e.cause.replace('_', ' ')}</span></li>)}
            {c.counts.unexpected > 8 ? <li className="muted">and {c.counts.unexpected - 8} more</li> : null}
          </ul>
        </>
      ) : null}
      {r.policy && r.policy.verdict === 'blocked' ? <p className="muted">Policy on the actual effects: {r.policy.findings.filter((f) => f.severity === 'block').map((f) => f.title).join('; ')}</p> : null}
      <div className="inc-proof">
        <strong>{exec.status === 'refused' ? 'No change was attempted.' : 'Rolled back before commit.'}</strong>{' '}
        {r.state_restored !== undefined && r.state_restored !== null ? <>State digest {short(r.pre_state)} before, {short(r.post_state)} after: {r.state_restored ? 'identical' : 'DIFFERENT'}. </> : null}
        {r.intact ? <>{r.intact.intact} of {r.intact.checked} touched rows re-read intact. </> : null}
        {r.journal_residue !== undefined ? <>Journal residue {r.journal_residue}.</> : null}
      </div>
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => { ref.current?.close(); onRetry(); }}>Simulate again on current data</button>
        <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>Read the receipt</button>
      </div>
    </dialog>
  );
}

// ---------- meanwhile in the business ----------
const DRIFTS = [
  { kind: 'new_order', title: 'A target customer phones in an order', how: 'a new child row: invisible to the row-version check' },
  { kind: 'reopen_case', title: 'Support reopens a target’s case', how: 'an update to a row the simulation read' },
  { kind: 'ledger_mirroring', title: 'Finance switches on ledger mirroring', how: 'a setting a trigger reads; no target row changes' },
];
export function Meanwhile({ onDrift, busy, log, active }: { onDrift: (k: string) => void; busy: string | null; log: string[]; active: boolean }) {
  return (
    <section className="panel meanwhile" aria-labelledby="mw-title">
      <h2 id="mw-title">Meanwhile, in the business</h2>
      <p className="muted">The shop keeps running between approval and execution. Make something happen, then execute.</p>
      <ul role="list" className="drifts">
        {DRIFTS.map((d) => (
          <li key={d.kind}><button type="button" className="btn drift" onClick={() => onDrift(d.kind)} disabled={!!busy || !active}><span>{d.title}</span><span className="muted small">{d.how}</span></button></li>
        ))}
      </ul>
      {!active ? <p className="muted small">Available once a customer clean-up has a safe simulation.</p> : null}
      {log.length ? <ol className="drift-log" role="list" aria-live="polite">{log.map((l, i) => <li key={i}>{l}</li>)}</ol> : null}
    </section>
  );
}

// ---------- leaving the building ----------
export function Outbox({ state }: { state: State }) {
  const now = useNow();
  const pending = state.outbox.filter((m) => m.status === 'pending');
  const next = pending.length ? Math.min(...pending.map((m) => Date.parse(m.created_at) + state.hold_s * 1000)) - now : 0;
  const cancelled = state.outbox.filter((m) => m.status === 'cancelled').length;
  return (
    <section className="panel outbox" aria-labelledby="ob-title">
      <h2 id="ob-title">Leaving the building</h2>
      <p>
        <strong>{pending.length}</strong> pending{pending.length ? <> · next dispatch in <span className="mono">{clock(next)}</span></> : null}
        {' · '}<strong>{state.deliveries}</strong> delivered{cancelled ? <> · {cancelled} cancelled before dispatch</> : null}
      </p>
      <p className="muted small">Committed changes queue provider messages. They wait {state.hold_s} s, then a dispatcher sends them to the (fictional) providers. A restoration can cancel a pending message; a delivered one can only be compensated.</p>
      {state.outbox.length ? (
        <ul role="list" className="ob-list mono small">
          {state.outbox.slice(0, 8).map((m) => <li key={m.id} className={`ob-${m.status}`}><span>{m.status}</span> {m.topic} <span className="muted">{m.aggregate}</span></li>)}
        </ul>
      ) : null}
    </section>
  );
}

export function Audit({ log }: { log: AuditLog | null }) {
  if (!log) return null;
  return (
    <details className="panel audit">
      <summary><h2>Audit chain</h2> <span className={`chip ${log.verified ? 'ok' : 'danger'}`}>{log.verified ? 'hash chain verified' : 'chain broken'}</span> <span className="muted">{plural(log.events.length, 'event')}</span></summary>
      <ol role="list" className="mono small audit-list">
        {log.events.slice(-30).reverse().map((e) => <li key={e.seq}><span className="muted">#{e.seq} {time(e.at)}</span> {e.type} <span className="muted">{short(e.hash)}</span></li>)}
      </ol>
    </details>
  );
}
