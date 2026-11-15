import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Action, type Approval, type AuditLog, type Execution, type Session, type Simulation, type State } from './api.ts';
import { Canvas } from './Canvas.tsx';
import { Diff } from './Diff.tsx';
import { Audit, Decision, Incident, isRestore, Meanwhile, Outbox, Proposal, ReceiptPanel, Verdict } from './Panels.tsx';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M2.5 15 Q 6 12.5 9.5 15 T 16.5 15 T 23.5 15 T 29.5 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M2.6 17 A 14 14 0 0 0 29.4 17 Z" fill="currentColor" opacity=".16" />
      <line x1="16" y1="5" x2="16" y2="22.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.6 22.5 h4.8 l-1 4.2 h-2.8 Z" fill="currentColor" />
    </svg>
  );
}

const STEPS = ['Intent', 'Simulate', 'Measure', 'Review', 'Approve', 'Execute', 'Verify', 'Recover'];
type Saved = { actionId?: string; simId?: string; approval?: Approval; execId?: string };
const store = {
  load(): Saved { try { return JSON.parse(sessionStorage.getItem('snd.flow') ?? '{}'); } catch { return {}; } },
  save(s: Saved) { try { sessionStorage.setItem('snd.flow', JSON.stringify(s)); } catch { /* storage unavailable: the flow just won't survive a reload */ } },
};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [audit, setAudit] = useState<AuditLog | null>(null);
  const [intent, setIntent] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [exec, setExec] = useState<Execution | null>(null);
  const [incident, setIncident] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [months, setMonths] = useState<number | ''>('');
  const [driftLog, setDriftLog] = useState<string[]>([]);
  const [theme, setTheme] = useState<string | null>(() => { try { return localStorage.getItem('snd.theme'); } catch { return null; } });
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem('snd.theme', theme); else localStorage.removeItem('snd.theme'); } catch { /* per-viewer convenience only */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    try { const [s, a] = await Promise.all([api.state(), api.audit()]); setState(s); setAudit(a); } catch { /* the next poll retries */ }
  }, []);

  // Persist the flow position so a reload resumes it.
  useEffect(() => { store.save({ actionId: action?.id, simId: sim?.id, approval: approval ?? undefined, execId: exec?.id }); }, [action, sim, approval, exec]);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.session();
        setSession(s);
        const saved = s.created ? {} : store.load();
        if (saved.actionId) {
          const a = await api.action(saved.actionId).catch(() => null);
          if (a) {
            setAction(a);
            if (saved.simId) setSim(await api.simulation(saved.simId).catch(() => null));
            if (saved.execId) setExec(await api.execution(saved.execId).catch(() => null));
            else if (saved.approval && Date.parse(saved.approval.expires_at) > Date.now() && a.status === 'proposed') setApproval(saved.approval);
          }
        }
        await refresh();
      } catch (e) { setError((e as Error).message); }
    })();
  }, [refresh]);

  // Poll the workspace state: faster while messages wait in the outbox.
  useEffect(() => {
    const pending = state?.outbox.some((m) => m.status === 'pending');
    const h = setTimeout(refresh, pending ? 4000 : 15000);
    return () => clearTimeout(h);
  }, [state, refresh]);

  async function run<T>(label: string, f: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(label); setError(null);
    try { const r = await f(); if (done) setStatus(done); return r; }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.'); return undefined; }
    finally { setBusy(null); void refresh(); }
  }
  function begin(a: Action) {
    setAction(a); setSim(null); setApproval(null); setExec(null); setIncident(false); setSelected(null); setEditing(false); setExcluded(new Set(a.spec.exclude));
    setMonths(a.spec.params.months ?? a.spec.params.days ?? '');
  }
  async function simulateNow(a: Action) {
    const s = await run('simulate', () => api.simulate(a.id));
    if (s) { setSim(s); setApproval(null); setExec(null); setSelected(null); setStatus(`Simulation ${s.verdict}: ${s.effects.length} row changes measured, nothing kept.`); }
  }
  const propose = (text: string) => run('propose', async () => {
    const a = await api.propose({ intent: text });
    begin(a);
    const s = await api.simulate(a.id);
    setSim(s);
    setStatus(`Planned and simulated: ${s.verdict}, ${s.effects.length} row changes measured, nothing kept.`);
    main.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  const revise = () => sim && run('revise', async () => {
    const a = await api.revise(sim.id);
    begin(a);
    setSim(await api.simulate(a.id));
  }, 'The agent narrowed the plan and simulated it again.');
  const approve = () => sim && run('approve', async () => setApproval(await api.approve(sim.id)), 'Approved: bound to this exact effect set for 5 minutes.');
  const reject = () => sim && run('reject', async () => { await api.reject(sim.id); setAction(null); setSim(null); setApproval(null); }, 'Rejected. Nothing ran.');
  const execute = () => approval && run('execute', async () => {
    const x = await api.execute(approval.id, approval.nonce);
    setExec(x); setApproval(null);
    if (x.status !== 'committed') setIncident(true);
    setStatus(x.status === 'committed' ? 'Committed: the verifier matched every row change to the approval.' : `${x.status === 'refused' ? 'Refused' : 'Rolled back'}: ${x.receipt.reason}`);
  });
  const restore = () => exec && run('restore', async () => { const a = await api.restore(exec.id); begin(a); setSim(await api.simulate(a.id)); }, 'Restoration planned and simulated.');
  const retry = () => { if (action) { setExec(null); setIncident(false); void simulateNow(action); } };
  const applyEdit = () => action && run('edit', async () => {
    const isDays = action.spec.template === 'cancel_stale_orders';
    const ids = new Set(action.spec.target_ids);
    const exclude = [...excluded].filter((x) => ids.has(x) || action.spec.exclude.includes(x));
    const include = action.spec.exclude.filter((x) => !excluded.has(x));
    const a = await api.edit(action.id, { ...(months === '' ? {} : isDays ? { days: months } : { months }), exclude, include });
    begin(a);
    setSim(await api.simulate(a.id));
  }, 'Scope changed; the new action was simulated.');
  const drift = (kind: string) => run('drift', async () => { const d = await api.drift(kind); setDriftLog((l) => [d.text, ...l].slice(0, 5)); }, 'Something changed in the business.');
  const reset = () => run('reset', async () => { await api.reset(); setAction(null); setSim(null); setApproval(null); setExec(null); setDriftLog([]); setIntent(''); }, 'Workspace reset to fresh synthetic data.');

  const step = !action ? 0 : !sim ? 1 : exec ? (exec.status === 'committed' ? (isRestore(action) ? 7 : 6) : 6) : approval ? 5 : sim.verdict === 'blocked' ? 3 : 4;
  const purgeSafe = !!(sim && sim.verdict === 'safe' && action?.spec.template === 'purge_inactive_customers' && action.status !== 'executed' && !exec);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="brand"><Logo /><div><span className="name">SOUNDING</span><span className="tagline">See the consequences before they become real.</span></div></div>
        <div className="top-actions">
          {session ? <span className="chip mono" title="Your private synthetic workspace">{session.workspace}</span> : null}
          <button type="button" className="btn ghost sm" onClick={reset} disabled={!!busy || !session}>Reset data</button>
          <button type="button" className="btn ghost sm" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? null : 'dark')} aria-label={`Theme: ${theme ?? 'system'}. Change theme.`}>{theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'}</button>
        </div>
      </header>
      <nav aria-label="Progress" className="stepper">
        <ol role="list">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}><span className="dot" aria-hidden="true" />{s}</li>)}</ol>
      </nav>
      <div className="sr-only" aria-live="polite">{status}</div>
      {error ? <div className="toast" role="alert"><span>{error}</span><button type="button" className="btn ghost xs" onClick={() => setError(null)} aria-label="Dismiss">✕</button></div> : null}

      <main id="main" ref={main} className={`layout${sim ? ' has-sim' : ''}`}>
        <div className="col col-left">
          <section className="panel composer" aria-labelledby="ask-title">
            <h2 id="ask-title">Ask the agent</h2>
            <form onSubmit={(e) => { e.preventDefault(); if (session && intent.trim()) void propose(intent.trim()); }}>
              <label htmlFor="intent" className="sr-only">Business request</label>
              <textarea id="intent" rows={2} maxLength={200} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder={session?.examples[0] ?? ''} />
              <div className="examples">
                {(session?.examples ?? []).map((x) => <button key={x} type="button" className="chip-btn" onClick={() => { setIntent(x); void propose(x); }} disabled={!!busy || !session}>{x}</button>)}
              </div>
              <button type="submit" className="btn primary" disabled={!!busy || !session || !intent.trim()}>{busy === 'propose' ? 'Planning and simulating…' : 'Plan and simulate'}</button>
            </form>
            <p className="muted small">Two allowlisted actions on a synthetic shop database: purge inactive customers, cancel unpaid orders. No SQL is accepted, and nothing runs until it is simulated, reviewed and approved.</p>
          </section>
          {action ? <Proposal action={action} sim={sim} excluded={excluded} editing={editing} onToggle={(id) => setExcluded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} /> : null}
          {action && !isRestore(action) ? <Meanwhile onDrift={drift} busy={busy} log={driftLog} active={purgeSafe || !!approval} /> : null}
        </div>

        <div className="col col-main">
          {sim ? <Canvas sim={sim} tables={state?.tables ?? {}} selected={selected} onSelect={setSelected} restore={isRestore(action!)} /> : <Intro tables={state?.tables} />}
          {sim ? <Diff key={sim.id} sim={sim} selected={selected} onClear={() => setSelected(null)} /> : null}
        </div>

        <div className="col col-right">
          {sim ? <Verdict sim={sim} rules={session?.rules ?? {}} /> : null}
          {action && !exec && action.status === 'proposed' ? (
            <Decision action={action} sim={sim} approval={approval} busy={busy} editing={editing} months={months} setMonths={setMonths}
              onSimulate={() => simulateNow(action)} onRevise={revise} onApprove={approve} onReject={reject} onExecute={execute}
              onEdit={() => setEditing(true)} onCancelEdit={() => { setEditing(false); setExcluded(new Set(action.spec.exclude)); }} onApplyEdit={applyEdit} />
          ) : null}
          {exec ? <ReceiptPanel exec={exec} onRestore={restore} onRetry={retry} busy={busy} /> : null}
          {state ? <Outbox state={state} /> : null}
          <Audit log={audit} />
        </div>
      </main>
      {exec && incident ? <Incident exec={exec} onClose={() => setIncident(false)} onRetry={retry} /> : null}
      <footer className="foot muted small">Synthetic data only, isolated per browser and reset on request. Policy {session?.policy ?? '—'}. Source and evidence: see the repository README.</footer>
    </>
  );
}

function Intro({ tables }: { tables?: Record<string, number> }) {
  return (
    <section className="panel intro" aria-labelledby="intro-title">
      <h2 id="intro-title">An agent wants to change your data.</h2>
      <p>Before anything is approved, SOUNDING runs the change for real inside a transaction that is always rolled back, and measures every row it touches: the rows you asked for, and the ones that come with them through cascades, nulled references and triggers.</p>
      <ol className="intro-steps">
        <li><strong>Simulate.</strong> The exact mutation the executor would run, journalled row by row, then rolled back and proven gone.</li>
        <li><strong>Review.</strong> Policy reads the measured effects, not the request. Unsafe plans are blocked; the agent narrows them using the evidence.</li>
        <li><strong>Approve.</strong> A one-time binding to the effect digest, row versions, schema and policy, valid for five minutes.</li>
        <li><strong>Execute and verify.</strong> The same change, re-measured inside the real transaction. Any row change that was not approved rolls everything back.</li>
        <li><strong>Recover.</strong> Committed deletions can be restored for 24 hours, through the same gate.</li>
      </ol>
      <p className="muted">Pick an example on the left to begin. Your workspace holds Larkspur Outfitters, a fictional shop{tables ? `: ${tables.customers} customers, ${tables.orders} orders, ${tables.invoices} invoices, ${tables.payments} payments, ${tables.shipments} shipments and ${tables.support_cases} support cases` : ''}. Every record is synthetic.</p>
    </section>
  );
}
