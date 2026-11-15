// Simulation accuracy evaluation. For each seed: a fresh synthetic workspace, randomised scope and a randomised
// drift, run through the real gate. Every number in the output is counted from database results; nothing is estimated.
// Usage: node scripts/eval.ts [seeds=40]   (writes docs/evidence/eval.json; CI re-runs it and diffs)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Db } from '../src/db.ts';
import { Engine, stateDigest } from '../src/engine.ts';
import { effectsFrom, type Effect, type Journal } from '../src/effects.ts';
import { rng } from '../src/seed.ts';
import { TEMPLATES, type Spec } from '../src/templates.ts';

type Tally = Record<string, number>;
const DRIFTS = ['none', 'new_order', 'reopen_case', 'ledger_mirroring'] as const;

export async function evaluate(url: string, seeds: number[]) {
  const db = new Db(url, 8);
  await db.migrate();
  const e = new Engine(db, { secret: 'eval', outboxHoldS: 3600, maxWorkspaces: 1e6 });
  // Failure counters start at zero so a clean run reports 0 explicitly rather than omitting the key.
  const t: Tally = Object.fromEntries(['side_effects_escaping_simulation', 'false_safe_commit_under_drift', 'double_execution', 'rollback_left_changes', 'replay_executed', 'revisions_still_blocked'].map((k) => [k, 0]));
  const inc = (k: string, n = 1) => { t[k] = (t[k] ?? 0) + n; };
  const cases: Record<string, unknown>[] = [];
  let tp = 0, fp = 0, fn = 0, naiveHit = 0, naiveTotal = 0;
  try {
    for (const seed of seeds) {
      const r = rng(seed * 7919);
      e.o.seed = seed;
      const ws = await e.createWorkspace(`eval-${seed}-${Math.random()}`);
      const template = r() < 0.7 ? 'purge_inactive_customers' : 'cancel_stale_orders';
      const params = template === 'purge_inactive_customers' ? { months: 18 } : { days: [14, 21, 30, 45][Math.floor(r() * 4)] };
      // Random operator exclusions, then the agent's own narrowing if the dry run blocks the plan.
      const all = await db.tx(ws, (q) => TEMPLATES[template].resolve(q, ws, { params, exclude: [] }));
      const exclude = all.filter(() => r() < 0.1);
      let a = await e.propose(ws, { template, params, exclude }, 'eval');
      let s = await e.simulate(ws, a.id);
      inc('simulations');
      const durable = (x: typeof s) => (x.report as { durable: { unchanged: boolean; journal_residue_after_rollback: number; deliveries_after: number; deliveries_before: number } }).durable;
      const check = (x: typeof s) => { const d = durable(x); if (!d.unchanged || d.journal_residue_after_rollback || d.deliveries_after !== d.deliveries_before) inc('side_effects_escaping_simulation'); };
      check(s);
      const eff = s.effects as Effect[];
      naiveTotal += eff.length; naiveHit += eff.filter((x) => x.cause === 'direct').length;
      if (s.verdict === 'blocked') {
        inc('initial_plans_blocked');
        inc('blocking_rows_prevented', (s.report as { policy: { findings: { severity: string; rows: unknown[] }[] } }).policy.findings.filter((f) => f.severity === 'block').reduce((n, f) => n + f.rows.length, 0));
        a = await e.agentRevision(ws, String(s.id));
        s = await e.simulate(ws, a.id);
        inc('simulations'); check(s);
        if (s.verdict !== 'safe') { inc('revisions_still_blocked'); continue; }
        inc('revisions_safe');
      }
      const apr = await e.approve(ws, String(s.id), 'eval');
      const drift = template === 'purge_inactive_customers' ? DRIFTS[Math.floor(r() * DRIFTS.length)] : 'none';
      if (drift !== 'none') { await e.drift(ws, drift); inc(`drift_injected:${drift}`); }
      const pre = await db.tx(ws, (q) => stateDigest(q, ws));
      // Two concurrent attempts with the same approval: at most one may run.
      const [x1, x2] = await Promise.allSettled([e.execute(ws, apr.id, apr.nonce, 'eval'), e.execute(ws, apr.id, apr.nonce, 'eval')]);
      const done = [x1, x2].filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<Record<string, unknown>>).value);
      if (done.length !== 1) inc('double_execution');
      else inc('concurrent_duplicate_refused');
      const x = done[0];
      inc(`outcome:${drift}:${x.status}`);
      const receipt = x.receipt as { state_restored?: boolean; checks: { name: string; ok: boolean }[]; comparison?: { counts: { unexpected: number } } };
      if (x.status === 'committed') {
        const [row] = await db.q<{ recovery: Journal }>(ws, 'select recovery from executions where id = $1', [x.id]);
        const actual = new Set(effectsFrom(row.recovery, TEMPLATES[template].direct(a.spec as Spec)).map((y) => y.key));
        const predicted = new Set((s.effects as Effect[]).map((y) => y.key));
        for (const k of predicted) if (actual.has(k)) tp++; else fn++;
        for (const k of actual) if (!predicted.has(k)) fp++;
        if (drift !== 'none' && drift !== 'reopen_case') inc('false_safe_commit_under_drift');
      } else {
        const post = await db.tx(ws, (q) => stateDigest(q, ws));
        if (post.digest !== pre.digest || receipt.state_restored === false) inc('rollback_left_changes');
        else inc('rollback_or_refusal_state_verified');
        if (receipt.comparison) inc('unapproved_rows_a_blind_executor_would_have_changed', receipt.comparison.counts.unexpected);
        const by = receipt.checks.find((c) => !c.ok)?.name ?? 'none';
        inc(`caught_by:${drift}:${by}`);
      }
      // Replay of a consumed or failed approval.
      try { await e.execute(ws, apr.id, apr.nonce, 'eval'); inc('replay_executed'); } catch { inc('replay_refused'); }
      if (x.status === 'committed') {
        const ra = await e.proposeRestore(ws, String(x.id), 'eval');
        const rs = await e.simulate(ws, ra.id); check(rs);
        if (rs.verdict === 'safe') {
          const rapr = await e.approve(ws, String(rs.id), 'eval');
          const rx = await e.execute(ws, rapr.id, rapr.nonce, 'eval');
          inc(`restore:${rx.status}`);
        } else inc('restore:blocked');
      }
      cases.push({ seed, template, params, excluded_by_operator: exclude.length, targets: a.spec.target_ids.length, drift, outcome: x.status, effects: (s.effects as Effect[]).length });
      await db.q('*', 'delete from workspaces where id = $1', [ws]);
    }
  } finally { await db.close(); }
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1;
  return {
    seeds: seeds.length,
    effect_set_on_commit: { predicted_and_actual: tp, actual_not_predicted: fp, predicted_not_actual: fn, precision, recall },
    naive_agent_projection_recall: naiveTotal ? Math.round((naiveHit / naiveTotal) * 1000) / 1000 : null,
    tallies: Object.fromEntries(Object.entries(t).sort()),
    cases,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2] ?? 40);
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:55432/sim_test';
  const res = await evaluate(url, Array.from({ length: n }, (_, i) => i + 1));
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs/evidence/eval.json');
  writeFileSync(out, JSON.stringify({ about: 'Generated by scripts/eval.ts against PostgreSQL; every value is counted, none estimated.', ...res }, null, 1) + '\n');
  console.log(JSON.stringify({ ...res, cases: `${res.cases.length} cases` }, null, 1));
}
