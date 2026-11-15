// The gate. Simulation runs the real mutation in a rollback-only transaction and measures it; approval binds a human
// decision to that exact evidence; execution re-checks the binding under locks, runs the same mutation, measures it
// again and commits only if reality matches what was approved. Everything is per workspace.
import { createHmac, randomBytes } from 'node:crypto';
import { CommitUnknown, Db, schemaFingerprint, type Q } from './db.ts';
import { canonical, compare, effectDigest, effectsFrom, sha, stable, summarize, type Direct, type Effect, type Journal, type Row } from './effects.ts';
import { evaluate, POLICY_VERSION, type PolicyResult } from './policy.ts';
import { TABLES, type Table } from './schema.ts';
import { generate, insertSeed } from './seed.ts';
import { PlanError, RESTORE, TEMPLATES, type ApplyResult, type Original, type Spec } from './templates.ts';
import { AGENT, compile, expectation, revise } from './agent.ts';

export class HttpError extends Error {
  status: number; code: string; data?: unknown;
  constructor(status: number, code: string, message: string, data?: unknown) { super(message); this.status = status; this.code = code; this.data = data; }
}
/** The approval this execution claimed was resolved by another process before its transaction began. */
class Reclaimed extends Error {}
/** Per-workspace history limits. A demo session needs a handful; Reset clears them. */
export const QUOTA = { simulations: 40, actions: 120, drifts: 40 };
class Refused extends Error { reason: string; checks: Check[]; constructor(reason: string, checks: Check[]) { super(reason); this.reason = reason; this.checks = checks; } }
class VerifyFailed extends Error {
  checks: Check[]; cmp: ReturnType<typeof compare>; policy: PolicyResult; pre: Digest; attempted: Effect[];
  constructor(o: { checks: Check[]; cmp: ReturnType<typeof compare>; policy: PolicyResult; pre: Digest; attempted: Effect[] }) {
    super('verification failed'); this.checks = o.checks; this.cmp = o.cmp; this.policy = o.policy; this.pre = o.pre; this.attempted = o.attempted;
  }
}

export type Check = { name: string; ok: boolean; detail: string };
export type Digest = { digest: string; tables: Record<string, { rows: number; md5: string }> };
type Versions = Record<string, Record<string, string>>;

const id = (p: string) => `${p}_${randomBytes(6).toString('hex')}`;
const TRANSIENT: Record<string, string> = {
  '40001': 'a concurrent transaction conflicted (serialization failure)', '40P01': 'a deadlock was detected',
  '55P03': 'a row lock could not be acquired in time', '57014': 'the statement timed out',
};

export type EngineOpts = {
  secret: string; outboxHoldS?: number; simTtlMs?: number; approvalTtlMs?: number; recoveryMs?: number;
  maxWorkspaces?: number; idleMs?: number; seed?: number;
};
export type Hooks = { skipSchemaCheck?: boolean; skipVersionCheck?: boolean; beforeCommit?: (c: import('pg').PoolClient) => unknown; afterCommit?: () => unknown; afterClaim?: () => unknown };

export class Engine {
  db: Db; o: Required<EngineOpts>;
  /** Test-only fault injection. Never reachable over HTTP. */
  hooks: Hooks = {};
  #busy = 0;

  constructor(db: Db, o: EngineOpts) {
    this.db = db;
    this.o = { outboxHoldS: 60, simTtlMs: 10 * 60_000, approvalTtlMs: 5 * 60_000, recoveryMs: 24 * 3600_000, maxWorkspaces: 150, idleMs: 12 * 3600_000, seed: 1, ...o };
  }

  async #gate<T>(fn: () => Promise<T>): Promise<T> {
    // Simulations and executions each hold a connection for up to a few seconds; cap them so visitors cannot starve the pool.
    if (this.#busy >= 3) throw new HttpError(503, 'busy', 'SOUNDING is busy running other simulations. Try again in a moment.');
    this.#busy++;
    try { return await fn(); } finally { this.#busy--; }
  }

  // ---------- workspaces ----------
  async createWorkspace(tokenHash: string) {
    return this.#gate(async () => {
      const ws = id('ws');
      for (let attempt = 1; ; attempt++) {
        // Count and insert under one lock, so concurrent sessions cannot overshoot the cap (Codex R7-4).
        const ok = await this.db.tx('*', async (q) => {
          await q('select pg_advisory_xact_lock(hashtext($1))', ['workspaces']);
          const [{ n }] = await q<{ n: number }>('select count(*)::int as n from workspaces');
          if (n >= this.o.maxWorkspaces) return false;
          await this.#seed(q, ws, tokenHash);
          return true;
        }, { statementMs: 20_000 });
        if (ok) break;
        if (attempt === 2) throw new HttpError(503, 'full', 'The demo is at capacity. Try again later.');
        await this.purgeIdle(3600_000);
      }
      await this.audit(ws, 'workspace.created', { seed: this.o.seed });
      return ws;
    });
  }
  async #seed(q: Q, ws: string, tokenHash: string) {
    await q('delete from workspaces where id = $1', [ws]); // reset: everything of this workspace cascades away
    await q('insert into workspaces (id, token_hash, seed) values ($1, $2, $3)', [ws, tokenHash, this.o.seed]);
    await insertSeed(q, ws, generate(this.o.seed).rows);
  }
  async workspaceFor(tokenHash: string) {
    const [w] = await this.db.q<{ id: string }>('*', 'update workspaces set last_seen = now() where token_hash = $1 returning id', [tokenHash]);
    return w?.id;
  }
  async reset(ws: string) {
    const [w] = await this.db.q<{ token_hash: string }>('*', 'select token_hash from workspaces where id = $1', [ws]);
    if (!w) throw new HttpError(404, 'no-workspace', 'Workspace not found.');
    await this.#gate(() => this.db.tx(ws, (q) => this.#seed(q, ws, w.token_hash), { statementMs: 20_000 }));
    await this.audit(ws, 'workspace.reset', {});
  }
  async purgeIdle(idleMs = this.o.idleMs) {
    // A workspace lives at most as long as a recovery record, so every copy of erased data it holds (simulation
    // before-images, receipts, recovery records) is gone within that window plus one purge interval (Codex R6-10).
    const gone = await this.db.q('*', `delete from workspaces where last_seen < now() - make_interval(secs => $1) or created_at < now() - make_interval(secs => $2) returning id`,
      [idleMs / 1000, this.o.recoveryMs / 1000]);
    // Recovery copies of deleted data are kept only for their window (bounded retention).
    await this.db.q('*', `update executions set recovery = null, recovery_status = 'expired' where recovery_status = 'available' and recovery_expires_at < now()`);
    return gone.length;
  }

  /** A bounded history per workspace, so one visitor cannot fill the shared database (Codex R7-1). Reset clears it. */
  async #quota(ws: string) {
    const [u] = await this.db.q<{ sims: number; acts: number; drifts: number }>(ws, `select
      (select count(*)::int from simulations where workspace_id = $1) as sims, (select count(*)::int from actions where workspace_id = $1) as acts,
      (select count(*)::int from audit where workspace_id = $1 and type like 'drift.%') as drifts`, [ws]);
    if (u.sims >= QUOTA.simulations || u.acts >= QUOTA.actions || u.drifts >= QUOTA.drifts)
      throw new HttpError(429, 'workspace-full', `This workspace has reached its history limit (${QUOTA.simulations} simulations, ${QUOTA.actions} actions, ${QUOTA.drifts} business events). Reset data to start fresh.`);
  }

  // ---------- audit chain ----------
  async audit(ws: string, type: string, data: unknown) {
    await this.db.tx(ws, async (q) => {
      await q('select pg_advisory_xact_lock(hashtext($1))', [`audit:${ws}`]);
      const [last] = await q<{ seq: number; hash: string }>('select seq, hash from audit where workspace_id = $1 order by seq desc limit 1', [ws]);
      const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? 'genesis';
      const at = new Date().toISOString();
      const stored = JSON.parse(JSON.stringify(data ?? {})); // hash exactly what jsonb will hold
      const hash = sha(canonical({ seq, prev, type, data: stored, at }));
      await q('insert into audit (workspace_id, seq, at, type, data, prev_hash, hash) values ($1,$2,$3,$4,$5,$6,$7)', [ws, seq, at, type, JSON.stringify(data ?? {}), prev, hash]);
    });
  }

  // ---------- planning ----------
  async propose(ws: string, input: { intent?: string; template?: string; params?: Spec['params']; exclude?: string[] }, origin: string, parentId?: string, rationale?: string) {
    let template: keyof typeof TEMPLATES, params: Spec['params'], reading: string, intent: string;
    try {
      if (input.intent !== undefined) {
        if (typeof input.intent !== 'string') throw new PlanError('intent must be text.');
        ({ template, params, reading } = compile(input.intent)); intent = input.intent.trim();
      } else {
        if (input.template !== 'purge_inactive_customers' && input.template !== 'cancel_stale_orders') throw new PlanError('Unknown template.');
        template = input.template;
        const p = input.params ?? {};
        params = template === 'purge_inactive_customers' ? { months: Number(p.months) } : { days: Number(p.days) };
        reading = template; intent = `${template} ${canonical(params)}`;
      }
    } catch (e) { if (e instanceof PlanError) throw new HttpError(422, 'not-compilable', e.message); throw e; }
    const exclude = [...new Set((input.exclude ?? []).map(String))].filter((x) => /^[a-z]{3}_[0-9a-z]{1,20}$/.test(x)).sort().slice(0, 500);
    const t = TEMPLATES[template];
    let target_ids: string[];
    try { target_ids = await this.db.tx(ws, (q) => t.resolve(q, ws, { params, exclude })); }
    catch (e) { if (e instanceof PlanError) throw new HttpError(422, 'bad-params', e.message); throw e; }
    const spec: Spec = { template, params, exclude, target_ids, mode: template === 'purge_inactive_customers' ? 'recoverable_delete' : 'recoverable_update' };
    return this.#storeAction(ws, spec, origin, intent, parentId, rationale ?? `Compiled as: ${reading}.`);
  }
  async #storeAction(ws: string, spec: Spec, origin: string, intent: string, parentId?: string, rationale?: string) {
    await this.#quota(ws);
    const aid = id('act');
    const exp = expectation(spec);
    await this.db.q(ws, `insert into actions (id, workspace_id, parent_id, origin, intent, spec, spec_hash, expectation, rationale) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [aid, ws, parentId ?? null, origin, intent, JSON.stringify(spec), sha(canonical(spec)), JSON.stringify(exp), rationale ?? null]);
    await this.audit(ws, 'action.proposed', { action: aid, origin, template: spec.template, targets: spec.target_ids.length, parent: parentId ?? null });
    return this.action(ws, aid);
  }
  async action(ws: string, aid: string) {
    const [a] = await this.db.q<Row>(ws, 'select * from actions where workspace_id = $1 and id = $2', [ws, aid]);
    if (!a) throw new HttpError(404, 'no-action', 'Action not found.');
    return a as Row & { spec: Spec; status: string; id: string };
  }
  /** The operator changes scope: a new action (and so a new simulation and approval); the old one cannot be reused. */
  async edit(ws: string, aid: string, input: { months?: number; days?: number; exclude?: string[]; include?: string[] }, operator: string) {
    const a = await this.action(ws, aid);
    if (a.spec.template === 'restore_execution') throw new HttpError(409, 'not-editable', 'Restorations cannot be re-scoped.');
    const include = new Set((input.include ?? []).map(String));
    const exclude = [...a.spec.exclude, ...(input.exclude ?? []).map(String)].filter((x) => !include.has(x));
    const params = a.spec.template === 'purge_inactive_customers' ? { months: input.months ?? a.spec.params.months } : { days: input.days ?? a.spec.params.days };
    await this.#supersede(ws, aid);
    return this.propose(ws, { template: a.spec.template, params, exclude }, operator, aid, `Scope changed by the operator.`);
  }
  async agentRevision(ws: string, simId: string) {
    const s = await this.simulation(ws, simId);
    const a = await this.action(ws, s.action_id as string);
    const r = revise(a.spec, (s.report as { policy: PolicyResult }).policy);
    if (!r) throw new HttpError(409, 'no-revision', 'The agent cannot narrow this plan any further; reject it or change the scope.');
    await this.#supersede(ws, a.id);
    return this.propose(ws, { template: a.spec.template, params: a.spec.params, exclude: r.exclude }, AGENT, a.id, r.rationale);
  }
  async #supersede(ws: string, aid: string) {
    // Waits on the row lock a running execution holds, then sees its outcome (Codex R6-1).
    const done = await this.db.q(ws, `update actions set status = 'superseded' where workspace_id = $1 and id = $2 and status = 'proposed' returning id`, [ws, aid])
      .catch((e) => { if ((e as { code?: string }).code === '55P03') throw new HttpError(409, 'busy', 'This action is executing right now.'); throw e; });
    if (!done.length) throw new HttpError(409, 'not-editable', 'This action is no longer open; it was executed, rejected or replaced.');
    await this.db.q(ws, `update approvals set status = 'rejected', outcome = 'superseded by a modified action' where workspace_id = $1 and status = 'approved'
      and simulation_id in (select id from simulations where action_id = $2)`, [ws, aid]);
  }
  async proposeRestore(ws: string, execId: string, operator: string) {
    const o = await this.#original(ws, execId);
    if (o.status !== 'committed') throw new HttpError(409, 'not-restorable', 'Only a committed execution can be restored.');
    const spec: Spec = { template: 'restore_execution', params: { execution_id: execId }, exclude: [], target_ids: o.spec.target_ids, mode: 'compensating_restore' };
    return this.#storeAction(ws, spec, operator, RESTORE.title(o), undefined, 'Restoration is an action like any other: simulated, approved and verified.');
  }
  async #original(ws: string, execId: string): Promise<Original> {
    const [x] = await this.db.q<Row>(ws, `select e.status, e.recovery, e.recovery_status, e.recovery_expires_at, a.spec from executions e join actions a on a.id = e.action_id
      where e.workspace_id = $1 and e.id = $2`, [ws, execId]);
    if (!x) throw new HttpError(404, 'no-execution', 'Execution not found.');
    return { spec: x.spec as Spec, journal: x.recovery as Journal | null, status: String(x.status), recovery_status: x.recovery_status as string | null, expires: x.recovery_expires_at ? Date.parse(String(x.recovery_expires_at)) : null };
  }

  /** The direct-effect definition, target lock and mutation for a spec; the same object serves simulation and execution. */
  async #runner(ws: string, spec: Spec) {
    if (spec.template === 'restore_execution') {
      const o = await this.#original(ws, spec.params.execution_id!);
      const t = TEMPLATES[o.spec.template as keyof typeof TEMPLATES];
      return {
        rootTable: t.rootTable, direct: RESTORE.direct(o) as Direct,
        lock: (q: Q) => RESTORE.lock(q, ws, o), apply: (q: Q) => RESTORE.apply(q, ws, o), resolve: null,
      };
    }
    const t = TEMPLATES[spec.template];
    return {
      rootTable: t.rootTable, direct: t.direct(spec), lock: (q: Q) => t.lock(q, ws, spec),
      apply: (q: Q) => t.apply(q, ws, spec), resolve: (q: Q) => t.resolve(q, ws, spec),
    };
  }

  // ---------- simulation ----------
  async simulate(ws: string, aid: string) {
    const a = await this.action(ws, aid);
    if (a.status !== 'proposed') throw new HttpError(409, 'not-simulatable', `This action is ${a.status}; propose a new one.`);
    await this.#quota(ws);
    return this.#gate(async () => {
      const r = await this.#runner(ws, a.spec);
      const sid = id('sim'), t0 = Date.now();
      const outside = async () => ({ digest: await this.db.tx(ws, (q) => stateDigest(q, ws)), deliveries: await this.#count(ws, 'deliveries') });
      const before = await outside();
      let run: { fp: string; uncaptured: string[]; journal: Journal; versions: Versions; pre: Digest; inTxAfter: Digest; residue: number; applied: ApplyResult; predicate: string[] | null };
      for (let attempt = 1; ; attempt++) {
        try {
          run = await this.db.tx(ws, async (q) => {
            const { fp, uncaptured } = await schemaFingerprint(q);
            if (uncaptured.length) throw new HttpError(503, 'capture-incomplete', `Refusing to simulate, the measurement would be incomplete: ${uncaptured.join('; ')}.`);
            const pre = await stateDigest(q, ws);
            const predicate = r.resolve ? await r.resolve(q) : null;
            await q('savepoint dry_run');
            const applied = await r.apply(q);
            await q('set constraints all immediate'); // deferred constraint triggers fire now, inside the measurement
            const journal = await q<Journal[number]>('select seq, tbl, op, old_row, new_row from change_log where capture_id = $1 order by seq', [sid]);
            await q('rollback to savepoint dry_run');
            const [{ residue }] = await q<{ residue: number }>('select count(*)::int as residue from change_log where capture_id = $1', [sid]);
            const versions = await rowVersions(q, ws, journal); // same snapshot as the dry run (repeatable read)
            const inTxAfter = await stateDigest(q, ws);
            return { fp, uncaptured, journal, versions, pre, inTxAfter, residue, applied, predicate };
          }, { isolation: 'repeatable read', capture: sid, action: aid, rollbackOnly: true });
          break;
        } catch (e) {
          if ((e as { code?: string }).code === '40001' && attempt < 3) continue; // a simulation is safe to repeat
          if (TRANSIENT[(e as { code: string }).code]) throw new HttpError(503, 'transient', `Simulation aborted: ${TRANSIENT[(e as { code: string }).code]}. Nothing was changed.`);
          throw e;
        }
      }
      const after = await outside();
      const effects = effectsFrom(run.journal, r.direct);
      const policy = evaluate(effects, {
        template: a.spec.template === 'restore_execution' ? 'restore_execution' : a.spec.template, targetIds: a.spec.target_ids, now: Date.now(),
        rootTable: r.rootTable, predicateIds: run.predicate ?? undefined, restore: run.applied.restore,
      });
      const durable = {
        journal_rows_in_dry_run: run.journal.length, journal_residue_after_rollback: run.residue,
        state_before: before.digest.digest, state_after: after.digest.digest, unchanged: before.digest.digest === after.digest.digest && run.pre.digest === run.inTxAfter.digest,
        deliveries_before: before.deliveries, deliveries_after: after.deliveries,
      };
      const report = {
        policy, summary: summarize(effects), expectation: a.expectation, durable, isolation: 'repeatable read', ms: Date.now() - t0,
        modeled: modeled(effects, this.o.outboxHoldS), unknown: UNKNOWN, root_table: r.rootTable,
        targets: await this.#targets(ws, a.spec, r.rootTable, policy), predicate_now: run.predicate?.length ?? null,
      };
      const digest = effectDigest(effects);
      await this.db.q(ws, `insert into simulations (id, workspace_id, action_id, spec_hash, schema_fp, row_versions, effects, effect_digest, report, verdict, durable)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sid, ws, aid, a.spec_hash, run.fp, JSON.stringify(run.versions), JSON.stringify(effects), digest, JSON.stringify(report), policy.verdict, JSON.stringify(durable)]);
      // Only the latest simulation of an action may be acted on: an approval of an older one is revoked (Codex R6-6).
      // Strictly older ones, in the same order "latest" uses, so a slow older simulation cannot revoke a newer approval (Codex R9-8).
      await this.db.q(ws, `update approvals set status = 'rejected', outcome = 'superseded by a newer simulation' where workspace_id = $1 and status = 'approved'
        and simulation_id in (select o.id from simulations o, simulations me where o.workspace_id = $1 and o.action_id = $2 and me.workspace_id = $1 and me.id = $3
          and (o.created_at, o.id) < (me.created_at, me.id))`, [ws, aid, sid]);
      await this.audit(ws, 'simulation.completed', { simulation: sid, action: aid, verdict: policy.verdict, effects: effects.length, digest, unchanged: durable.unchanged });
      return this.simulation(ws, sid);
    });
  }
  async #count(ws: string, t: 'deliveries' | 'outbox') {
    const [{ n }] = await this.db.q<{ n: number }>(ws, `select count(*)::int as n from ${t} where workspace_id = $1`, [ws]);
    return n;
  }
  async #targets(ws: string, spec: Spec, root: 'customers' | 'orders', policy: PolicyResult) {
    const blocked = new Map<string, string[]>();
    for (const f of policy.findings) if (f.severity === 'block') for (const r of f.roots) blocked.set(r, [...(blocked.get(r) ?? []), f.rule]);
    const rows = root === 'customers'
      ? await this.db.q<Row>(ws, `select id, name, email, status, last_active_at as at from customers where workspace_id = $1 and id = any($2) order by id`, [ws, spec.target_ids])
      : await this.db.q<Row>(ws, `select o.id, c.name, c.email, o.status, o.placed_at as at, o.total_cents from orders o join customers c on c.workspace_id = o.workspace_id and c.id = o.customer_id
          where o.workspace_id = $1 and o.id = any($2) order by o.id`, [ws, spec.target_ids]);
    return rows.map((x) => ({ ...x, email: mask(String(x.email)), blocked_by: blocked.get(String(x.id)) ?? [] }));
  }
  async simulation(ws: string, sid: string) {
    const [s] = await this.db.q<Row>(ws, 'select * from simulations where workspace_id = $1 and id = $2', [ws, sid]);
    if (!s) throw new HttpError(404, 'no-simulation', 'Simulation not found.');
    return s;
  }

  // ---------- decision ----------
  #bindingHash(b: Row) { return createHmac('sha256', this.o.secret).update(canonical(b)).digest('hex'); }
  async approve(ws: string, sid: string, operator: string) {
    const s = await this.simulation(ws, sid);
    const a = await this.action(ws, s.action_id as string);
    if (a.status !== 'proposed') throw new HttpError(409, 'not-approvable', `This action is ${a.status}.`);
    if (s.verdict !== 'safe') throw new HttpError(409, 'blocked', 'The simulation found policy violations. This plan cannot be approved; narrow it and simulate again.');
    if (Date.now() - Date.parse(String(s.created_at)) > this.o.simTtlMs) throw new HttpError(409, 'stale-simulation', 'This simulation is older than 10 minutes. Simulate again against the current data.');
    const [latest] = await this.db.q<{ id: string }>(ws, 'select id from simulations where workspace_id = $1 and action_id = $2 order by created_at desc, id desc limit 1', [ws, a.id]);
    if (latest.id !== sid) throw new HttpError(409, 'stale-simulation', 'A newer simulation of this action exists; review that one.');
    const nonce = randomBytes(18).toString('base64url');
    const expires = new Date(Date.now() + this.o.approvalTtlMs).toISOString();
    const binding = {
      workspace: ws, operator, action_id: a.id, spec_hash: a.spec_hash, simulation_id: sid, effect_digest: s.effect_digest, effects: (s.effects as Effect[]).length,
      schema_fp: s.schema_fp, row_versions: sha(canonical(s.row_versions)), policy_version: POLICY_VERSION, expires_at: expires, nonce_hash: sha(nonce),
    };
    const apr = id('apr');
    try {
      await this.db.q(ws, `insert into approvals (id, workspace_id, simulation_id, operator, binding, binding_hash, nonce, status, expires_at) values ($1,$2,$3,$4,$5,$6,$7,'approved',$8)`,
        [apr, ws, sid, operator, JSON.stringify(binding), this.#bindingHash(binding), sha(nonce), expires]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'already-approved', 'This simulation already has an approval. Approvals are single-use: simulate again for a new one.');
      throw e;
    }
    await this.audit(ws, 'approval.granted', { approval: apr, simulation: sid, operator, effect_digest: s.effect_digest, expires_at: expires });
    return { id: apr, nonce, expires_at: expires, binding };
  }
  async reject(ws: string, sid: string, operator: string, reason = 'rejected by the operator') {
    const s = await this.simulation(ws, sid);
    const [a] = await this.db.q(ws, `update actions set status = 'rejected' where workspace_id = $1 and id = $2 and status = 'proposed' returning id`, [ws, s.action_id])
      .catch((e) => { if ((e as { code?: string }).code === '55P03') throw new HttpError(409, 'busy', 'This action is executing right now.'); throw e; });
    if (!a) throw new HttpError(409, 'not-rejectable', 'This action is no longer open.');
    await this.db.q(ws, `update approvals set status = 'rejected', outcome = $3 where workspace_id = $1 and status = 'approved' and simulation_id in (select id from simulations where action_id = $2)`, [ws, s.action_id, reason]);
    await this.audit(ws, 'action.rejected', { action: s.action_id, simulation: sid, operator, reason });
    return this.action(ws, String(s.action_id));
  }

  // ---------- execution ----------
  async execute(ws: string, aprId: string, nonce: string, operator: string) {
    // Admission first: a busy server must not consume the approval it then cannot run (Codex R6-5, R7-5).
    return this.#gate(() => this.#claimAndExecute(ws, aprId, nonce, operator));
  }
  async #claimAndExecute(ws: string, aprId: string, nonce: string, operator: string) {
    // 1. Claim the approval, once. A double click, a replay or a second operator finds it no longer 'approved'.
    const [apr] = await this.db.q<Row>(ws, `update approvals set status = 'executing' where workspace_id = $1 and id = $2 and nonce = $3 and status = 'approved'
      and expires_at > now() and operator = $4 returning *`, [ws, aprId, sha(String(nonce)), operator]);
    if (!apr) {
      const [x] = await this.db.q<Row>(ws, 'select status, expires_at, operator from approvals where workspace_id = $1 and id = $2', [ws, aprId]);
      const why = !x ? 'No such approval.' : x.operator !== operator ? 'This approval belongs to another operator session.'
        : x.status !== 'approved' ? `This approval is already ${x.status}; approvals are single-use.`
        : Date.parse(String(x.expires_at)) <= Date.now() ? 'This approval has expired.' : 'The approval token does not match.';
      throw new HttpError(409, 'approval-unusable', why);
    }
    await this.hooks.afterClaim?.();
    return this.#execute(ws, apr);
  }

  async #execute(ws: string, apr: Row) {
    const eid = id('exe'), t0 = Date.now();
    const s = await this.simulation(ws, String(apr.simulation_id));
    const a = await this.action(ws, String(s.action_id));
    const approved = s.effects as Effect[];
    const r = await this.#runner(ws, a.spec);
    const base = { execution_id: eid, action_id: a.id, simulation_id: s.id, approval_id: apr.id, operator: apr.operator, approved_digest: s.effect_digest, isolation: 'serializable' };
    const checks: Check[] = [];
    const bindingNow = { ...(apr.binding as Row) };
    // The signed binding must equal one rebuilt from the records execution will actually use, digests recomputed (Codex R6-4).
    const rebuilt = {
      workspace: ws, operator: apr.operator, action_id: a.id, spec_hash: sha(canonical(a.spec)), simulation_id: s.id, effect_digest: effectDigest(approved), effects: approved.length,
      schema_fp: s.schema_fp, row_versions: sha(canonical(s.row_versions)), policy_version: POLICY_VERSION, expires_at: new Date(apr.expires_at as string | Date).toISOString(), nonce_hash: apr.nonce,
    };
    checks.push({ name: 'approval binding', ok: this.#bindingHash(bindingNow) === apr.binding_hash && canonical(bindingNow) === canonical(rebuilt) && a.spec_hash === rebuilt.spec_hash && s.effect_digest === rebuilt.effect_digest,
      detail: 'the signed binding matches this workspace, operator, action, spec, simulation, effect digest, schema, row versions, policy and expiry' });
    let pre: Digest | undefined;
    try {
      if (!checks.every((c) => c.ok)) throw new Refused('The approval no longer matches its action.', checks);
      const outside = checks.length;
      const attempt = () => this.db.tx(ws, async (q) => {
        checks.length = outside; // a retried attempt re-runs every in-transaction check from scratch
        await q('select pg_advisory_xact_lock(hashtext($1))', [`exec:${ws}`]); // one execution per workspace at a time
        // Still ours? Start-up reconciliation in another process may have resolved this claim (Codex R6-2).
        const [mine] = await q<{ status: string }>('select status from approvals where workspace_id = $1 and id = $2 for update', [ws, apr.id]);
        if (mine?.status !== 'executing') throw new Reclaimed();
        // The action row stays locked until commit: a concurrent edit, revision or rejection waits, then finds it executed (Codex R6-1).
        const [act] = await q<{ status: string }>('select status from actions where workspace_id = $1 and id = $2 for update', [ws, a.id]);
        const [latest] = await q<{ id: string }>('select id from simulations where workspace_id = $1 and action_id = $2 order by created_at desc, id desc limit 1', [ws, a.id]);
        checks.push({ name: 'action still open', ok: act?.status === 'proposed' && latest?.id === s.id,
          detail: act?.status !== 'proposed' ? `action is ${act?.status}` : latest?.id !== s.id ? 'a newer simulation of this action exists' : 'locked; this is its latest simulation' });
        if (!checks.every((c) => c.ok)) throw new Refused('The action changed after it was approved.', checks);
        const { fp, uncaptured } = await schemaFingerprint(q);
        checks.push({ name: 'capture coverage', ok: !uncaptured.length, detail: uncaptured.length ? uncaptured.join('; ') : 'every table a change can reach journals it; no bookkeeping triggers' });
        const schemaOk = fp === s.schema_fp || !!this.hooks.skipSchemaCheck;
        checks.push({ name: 'schema unchanged', ok: schemaOk, detail: fp === s.schema_fp ? 'tables, constraints, triggers and functions match the simulation' : this.hooks.skipSchemaCheck ? 'CHANGED (check disabled by test hook)' : 'tables, constraints, triggers or functions changed since the simulation' });
        if (!checks.every((c) => c.ok)) throw new Refused('The database schema changed after the simulation.', checks);
        await r.lock(q);
        const now = await rowVersions(q, ws, null, s.row_versions as Versions);
        const stale = diffVersions(s.row_versions as Versions, now);
        checks.push({ name: 'row versions', ok: !stale.length || !!this.hooks.skipVersionCheck, detail: stale.length ? `${stale.length} row(s) changed since the simulation: ${stale.slice(0, 6).join(', ')}${stale.length > 6 ? '…' : ''}` : `${countVersions(now)} rows the simulation read are unchanged (locked)` });
        if (!checks.every((c) => c.ok)) throw new Refused('Records changed after the simulation; the approval is stale.', checks);
        pre = await stateDigest(q, ws);
        const applied = await r.apply(q);
        await q('set constraints all immediate');
        const journal = await q<Journal[number]>('select seq, tbl, op, old_row, new_row from change_log where capture_id = $1 order by seq', [eid]);
        const actual = effectsFrom(journal, r.direct);
        const cmp = compare(approved, actual);
        checks.push({ name: 'effects match approval', ok: cmp.match, detail: cmp.match ? `${actual.length} row changes, identical to the ${approved.length} approved` : `${cmp.unexpected.length} unexpected, ${cmp.missing.length} missing, ${cmp.changed.length} different` });
        const post = await stateDigest(q, ws);
        const countsOk = TABLES.every((t) => post.tables[t].rows - pre!.tables[t].rows === actual.filter((e) => e.tbl === t && e.op === 'INSERT').length - actual.filter((e) => e.tbl === t && e.op === 'DELETE').length);
        checks.push({ name: 'independent row counts', ok: countsOk, detail: countsOk ? 'per-table row counts moved exactly as the journal says' : 'row counts disagree with the journal' });
        const policy = evaluate(actual, { template: a.spec.template, targetIds: a.spec.target_ids, now: Date.now(), rootTable: r.rootTable, restore: applied.restore });
        const policyOk = policy.verdict === 'safe';
        checks.push({ name: 'policy on actual effects', ok: policyOk, detail: policyOk ? `${POLICY_VERSION}: no violations` : policy.findings.filter((f) => f.severity === 'block').map((f) => f.rule).join(', ') });
        if (!checks.every((c) => c.ok)) throw new VerifyFailed({ checks, cmp, policy, pre: pre!, attempted: actual });
        const receipt = { ...base, status: 'committed', checks, pre_state: pre!.digest, post_state: post.digest, summary: summarize(actual), effects: actual.length, ms: Date.now() - t0,
          ...(applied.restore ? { irreversible: applied.restore.irreversible } : {}) }; // messages already delivered: compensated, not unsent (Codex R9-11)
        const recoverable = a.spec.template !== 'restore_execution';
        await q(`insert into executions (id, workspace_id, approval_id, simulation_id, action_id, status, receipt, recovery, recovery_status, recovery_expires_at)
          values ($1,$2,$3,$4,$5,'committed',$6,$7,$8,$9)`,
          [eid, ws, apr.id, s.id, a.id, JSON.stringify(receipt), recoverable ? JSON.stringify(journal) : null, recoverable ? 'available' : null, recoverable ? new Date(Date.now() + this.o.recoveryMs).toISOString() : null]);
        await q('delete from change_log where capture_id = $1', [eid]); // the journal lives on only as the recovery record
        await q(`update approvals set status = 'consumed', outcome = 'committed' where id = $1`, [apr.id]);
        await q(`update actions set status = 'executed' where id = $1`, [a.id]);
        if (a.spec.template === 'restore_execution') await q(`update executions set recovery_status = 'restored', recovery = null where workspace_id = $1 and id = $2`, [ws, a.spec.params.execution_id]);
        return receipt;
      }, { isolation: 'serializable', capture: eid, action: a.id, statementMs: 10_000, beforeCommit: this.hooks.beforeCommit, afterCommit: this.hooks.afterCommit });
      // SERIALIZABLE can abort on a false-positive conflict with an unrelated workspace's execution. The aborted attempt
      // changed nothing, so it is safe to run again: every check is repeated against the data as it is then.
      let out: Awaited<ReturnType<typeof attempt>>;
      for (let n = 1; ; n++) {
        try { out = await attempt(); break; } catch (e) {
          if (n < 5 && ['40001', '40P01'].includes((e as { code?: string }).code ?? '')) {
            pre = undefined; await new Promise((r) => setTimeout(r, 25 * n + Math.random() * 50)); continue;
          }
          throw e;
        }
      }
      await this.audit(ws, 'execution.committed', { execution: eid, approval: apr.id, effects: out.effects, post_state: out.post_state });
      return this.execution(ws, eid);
    } catch (e) {
      if (e instanceof Reclaimed) throw new HttpError(409, 'approval-unusable', 'This approval was resolved by another process; see its receipt.');
      if (e instanceof CommitUnknown) {
        // The connection died during COMMIT. The outcome is whatever PostgreSQL durably recorded. The original backend holds
        // the execution lock until its transaction ends, so take that lock before looking for the receipt (Codex R6-7).
        const [x] = await this.db.tx(ws, async (q) => {
          await q('select pg_advisory_xact_lock(hashtext($1))', [`exec:${ws}`]);
          return q<Row>('select id from executions where workspace_id = $1 and id = $2', [ws, eid]);
        }, { lockMs: 30_000, statementMs: 35_000 }).catch(() => { throw new HttpError(503, 'outcome-unknown', 'The outcome of this execution is not known yet. Reload in a few minutes: the receipt will say.'); });
        if (x) { await this.db.q(ws, `update approvals set status = 'consumed', outcome = 'committed (confirmed after connection loss)' where id = $1`, [apr.id]); return this.execution(ws, eid); }
        // Not ours, but another process (start-up reconciliation) may already have recorded the outcome for this approval.
        const [theirs] = await this.db.q<Row>(ws, 'select id from executions where workspace_id = $1 and approval_id = $2', [ws, apr.id]);
        if (theirs) return this.execution(ws, String(theirs.id));
        return this.#failed(ws, apr, eid, a, 'rolled_back', 'The connection was lost during COMMIT; no receipt was durably written, so the transaction did not commit.', checks, pre, base);
      }
      if (e instanceof Refused) return this.#failed(ws, apr, eid, a, 'refused', e.reason, e.checks, undefined, base);
      if (e instanceof VerifyFailed) return this.#failed(ws, apr, eid, a, 'rolled_back', 'Reality differed from the approved simulation. The transaction was rolled back before commit.', e.checks, e.pre, base, e);
      const code = (e as { code?: string }).code;
      if (code && TRANSIENT[code]) return this.#failed(ws, apr, eid, a, 'rolled_back', `Aborted: ${TRANSIENT[code]}. PostgreSQL rolled the transaction back.`, checks, pre, base);
      if (code === '23505' || code === '23503') return this.#failed(ws, apr, eid, a, 'rolled_back', `Aborted by a database constraint (${(e as Error).message}).`, checks, pre, base);
      await this.db.q(ws, `update approvals set status = 'failed', outcome = 'error' where id = $1 and status = 'executing'`, [apr.id]);
      throw e;
    }
  }

  async #failed(ws: string, apr: Row, eid: string, a: Row & { spec: Spec }, status: 'refused' | 'rolled_back', reason: string, checks: Check[], pre: Digest | undefined, base: Row, v?: VerifyFailed) {
    // Proof that nothing stuck: re-measure from a new transaction, and re-read every row the attempt touched.
    const post = await this.db.tx(ws, (q) => stateDigest(q, ws));
    let intact: { checked: number; intact: number } | null = null;
    if (v) {
      let ok = 0;
      const olds = v.attempted.filter((e) => e.before);
      for (const e of olds) {
        const [cur] = await this.db.q<{ r: Row }>(ws, `select to_jsonb(t) as r from ${e.tbl} t where workspace_id = $1 and id = $2`, [ws, e.id]);
        if (cur && canonical(stable(e.tbl, cur.r)) === canonical(e.before)) ok++;
      }
      const inserted = v.attempted.filter((e) => e.op === 'INSERT');
      for (const e of inserted) {
        const [cur] = await this.db.q(ws, `select 1 from ${e.tbl} where workspace_id = $1 and id = $2`, [ws, e.id]);
        if (!cur) ok++;
      }
      intact = { checked: olds.length + inserted.length, intact: ok };
    }
    const [{ residue }] = await this.db.q<{ residue: number }>(ws, 'select count(*)::int as residue from change_log where capture_id = $1', [eid]);
    const cap = (x: Effect[]) => x.slice(0, 60);
    const receipt = {
      ...base, status, reason, checks, pre_state: pre?.digest ?? null, post_state: post.digest,
      state_restored: pre ? pre.digest === post.digest : null, journal_residue: residue, intact,
      comparison: v ? { unexpected: cap(v.cmp.unexpected), missing: cap(v.cmp.missing), changed: v.cmp.changed.slice(0, 30), counts: { unexpected: v.cmp.unexpected.length, missing: v.cmp.missing.length, changed: v.cmp.changed.length } } : null,
      policy: v?.policy ?? null, next: 'Simulate again against the current data; a new approval is required.',
    };
    // Under the execution lock, and at most one receipt per approval: if reconciliation recorded one first, that one stands (Codex R9-6).
    const winner = await this.db.tx(ws, async (q) => {
      await q('select pg_advisory_xact_lock(hashtext($1))', [`exec:${ws}`]);
      const [mine] = await q(`insert into executions (id, workspace_id, approval_id, simulation_id, action_id, status, receipt) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (approval_id) do nothing returning id`, [eid, ws, apr.id, base.simulation_id, a.id, status, JSON.stringify(receipt)]);
      if (!mine) return String((await q<Row>('select id from executions where workspace_id = $1 and approval_id = $2', [ws, apr.id]))[0].id);
      await q(`update approvals set status = 'failed', outcome = $2 where id = $1 and status = 'executing'`, [apr.id, status]);
      return eid;
    }, { lockMs: 30_000, statementMs: 35_000 });
    if (winner !== eid) return this.execution(ws, winner);
    await this.audit(ws, `execution.${status}`, { execution: eid, approval: apr.id, reason, state_restored: receipt.state_restored });
    return this.execution(ws, eid);
  }

  async execution(ws: string, eid: string) {
    const [x] = await this.db.q<Row>(ws, 'select id, approval_id, simulation_id, action_id, status, receipt, recovery_status, recovery_expires_at, created_at from executions where workspace_id = $1 and id = $2', [ws, eid]);
    if (!x) throw new HttpError(404, 'no-execution', 'Execution not found.');
    return x;
  }

  /**
   * An approval left 'executing' by a dead process or a lost connection either has a receipt or rolled back.
   * At start-up every such approval is checked; periodically (`minAgeMs`) only ones claimed long enough ago that no live
   * execution can still hold them: a claim needs an unexpired approval, so expiry plus minAgeMs bounds the claim's age.
   */
  async recoverInterrupted(minAgeMs = 0) {
    const stuck = await this.db.q<Row>('*', `select a.id, a.workspace_id, a.simulation_id from approvals a where a.status = 'executing'
      and ($1 = 0 or a.expires_at < now() - make_interval(secs => $1))`, [minAgeMs / 1000]);
    let done = 0;
    for (const s of stuck) {
      const ws = String(s.workspace_id);
      // Under the execution lock and the approval row lock: a live execution in another process has either finished (its
      // receipt is visible) or not begun its transaction, and will then find the claim resolved (Codex R6-2).
      await this.db.tx(ws, async (q) => {
        await q('select pg_advisory_xact_lock(hashtext($1))', [`exec:${ws}`]);
        const [now] = await q<Row>(`select a.status, (select e.status from executions e where e.workspace_id = a.workspace_id and e.approval_id = a.id) as receipt,
          (select action_id from simulations m where m.workspace_id = a.workspace_id and m.id = a.simulation_id) as action_id
          from approvals a where a.workspace_id = $1 and a.id = $2 for update`, [ws, s.id]);
        if (now?.status !== 'executing') return;
        // A receipt says what happened; only a committed one consumes the approval (Codex R9-7).
        if (now.receipt) {
          await q(now.receipt === 'committed' ? `update approvals set status = 'consumed', outcome = 'committed (reconciled)' where id = $1`
            : `update approvals set status = 'failed', outcome = $2 where id = $1`, now.receipt === 'committed' ? [s.id] : [s.id, now.receipt]);
          return;
        }
        await q(`insert into executions (id, workspace_id, approval_id, simulation_id, action_id, status, receipt) values ($1,$2,$3,$4,$5,'rolled_back',$6)`,
          [id('exe'), ws, s.id, s.simulation_id, now.action_id, JSON.stringify({ status: 'rolled_back', reason: 'The server stopped during execution. No receipt was committed, so PostgreSQL rolled the transaction back.', next: 'Simulate again.' })]);
        await q(`update approvals set status = 'failed', outcome = 'interrupted' where id = $1`, [s.id]);
      }, { lockMs: 3_000 }).then(() => { done++; }, (e) => {
        // A live execution holds the lock: leave it to that execution, or to the next periodic pass (Codex R9-10).
        if ((e as { code?: string }).code !== '55P03') throw e;
      });
    }
    return done;
  }

  // ---------- the rest of the business, meanwhile ----------
  /** Ordinary business activity in the visitor's own workspace, committed normally (no capture), to create drift. */
  async drift(ws: string, kind: string) {
    if (!['ledger_mirroring', 'new_order', 'reopen_case'].includes(kind)) throw new HttpError(400, 'bad-drift', 'Unknown drift.');
    await this.#quota(ws);
    const [s] = await this.db.q<Row>(ws, `select s.id, s.effects, a.spec from simulations s join actions a on a.id = s.action_id
      where s.workspace_id = $1 and s.verdict = 'safe' and a.status = 'proposed' and a.spec->>'template' = 'purge_inactive_customers' order by s.created_at desc limit 1`, [ws]);
    if (kind === 'ledger_mirroring') {
      await this.db.q(ws, `update settings set enabled = true where workspace_id = $1 and id = 'ledger_mirroring'`, [ws]);
      await this.audit(ws, 'drift.ledger_mirroring', {});
      return { kind, text: 'Finance switched on ledger mirroring: removing a payment now books a reversal entry. No customer, order or payment row changed.' };
    }
    if (!s) throw new HttpError(409, 'no-safe-plan', 'Simulate a plan that passes policy first; drift is applied to its targets.');
    const spec = s.spec as Spec, effects = s.effects as Effect[];
    if (kind === 'new_order') {
      const cus = spec.target_ids[0];
      const o = `ord_${randomBytes(4).toString('hex')}`, inv = `inv_${randomBytes(4).toString('hex')}`;
      const name = await this.db.tx(ws, async (q) => {
        const [c] = await q<{ name: string }>('select name from customers where workspace_id = $1 and id = $2', [ws, cus]);
        const [p] = await q<{ id: string; price_cents: number }>(`select id, price_cents from products where workspace_id = $1 order by id limit 1`, [ws]);
        await q(`insert into orders (workspace_id, id, customer_id, status, placed_at, total_cents, updated_at) values ($1,$2,$3,'processing',now(),$4,now())`, [ws, o, cus, p.price_cents]);
        await q(`insert into order_lines values ($1,$2,$3,$4,1,$5)`, [ws, `lin_${randomBytes(4).toString('hex')}`, o, p.id, p.price_cents]);
        await q(`insert into invoices values ($1,$2,$3,$4,'open',$5,now())`, [ws, inv, o, `LO-${inv.slice(4)}`, p.price_cents]);
        return c.name;
      });
      await this.audit(ws, 'drift.new_order', { customer: cus, order: o });
      return { kind, customer: cus, order: o, text: `${name} (${cus}) just phoned in an order (${o}) with an open invoice. Their customer row is untouched.` };
    }
    if (kind === 'reopen_case') {
      const c = effects.find((e) => e.tbl === 'support_cases' && e.op === 'UPDATE' && e.before!.status === 'closed');
      if (!c) throw new HttpError(409, 'no-case', 'The current plan touches no closed support case.');
      await this.db.q(ws, `update support_cases set status = 'open' where workspace_id = $1 and id = $2`, [ws, c.id]);
      await this.audit(ws, 'drift.reopen_case', { case: c.id });
      return { kind, case: c.id, text: `Support reopened case ${c.id} ("${c.before!.subject}") for ${c.before!.customer_id}.` };
    }
    throw new HttpError(400, 'bad-drift', 'Unknown drift kind.');
  }

  // ---------- outbox ----------
  /** The only background writer. Sends committed messages after the hold window; it can never see uncommitted rows. */
  async dispatch() {
    const sent = await this.db.tx('*', async (q) => {
      const rows = await q<Row>(`update outbox set status = 'dispatched', dispatched_at = now() where (workspace_id, id) in (
        select workspace_id, id from outbox where status = 'pending' and created_at < now() - make_interval(secs => $1) order by created_at limit 200 for update skip locked)
        returning workspace_id, id, topic, payload`, [this.o.outboxHoldS]);
      for (const r of rows) await q(`insert into deliveries (workspace_id, outbox_id, provider, topic, payload) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [r.workspace_id, r.id, PROVIDERS[String(r.topic).split('.')[0]] ?? 'unknown', r.topic, JSON.stringify(r.payload)]);
      return rows.length;
    });
    return sent;
  }

  // ---------- read model ----------
  async state(ws: string) {
    const counts = await this.db.tx(ws, (q) => stateDigest(q, ws));
    const [settings] = await this.db.q<{ enabled: boolean }>(ws, `select enabled from settings where workspace_id = $1 and id = 'ledger_mirroring'`, [ws]);
    const outbox = await this.db.q(ws, `select id, topic, aggregate, status, created_at, dispatched_at from outbox where workspace_id = $1 order by created_at desc limit 40`, [ws]);
    const executions = await this.db.q(ws, `select id, action_id, status, receipt->>'reason' as reason, recovery_status, recovery_expires_at, created_at from executions where workspace_id = $1 order by created_at desc limit 20`, [ws]);
    const deliveries = await this.#count(ws, 'deliveries');
    return { workspace: ws, digest: counts.digest, tables: Object.fromEntries(Object.entries(counts.tables).map(([k, v]) => [k, v.rows])), ledger_mirroring: !!settings?.enabled, outbox, deliveries, executions, hold_s: this.o.outboxHoldS };
  }
  async records(ws: string, tbl: string, ids: string[]) {
    if (!TABLES.includes(tbl as Table)) throw new HttpError(400, 'bad-table', 'Unknown table.');
    const rows = await this.db.q<{ r: Row; xmin: string }>(ws, `select to_jsonb(t) as r, t.xmin::text as xmin from ${tbl} t where workspace_id = $1 and id = any($2) order by id`, [ws, ids.slice(0, 50)]);
    return rows.map((x) => ({ ...maskRow(x.r), _version: x.xmin }));
  }
  async auditLog(ws: string) {
    const rows = await this.db.q<Row>(ws, 'select seq, at, type, data, prev_hash, hash from audit where workspace_id = $1 order by seq', [ws]);
    let prev = 'genesis', ok = true;
    for (const r of rows) {
      const at = new Date(r.at as string | Date).toISOString(); // pg returns a Date; String(Date) would drop the milliseconds
      if (r.prev_hash !== prev || sha(canonical({ seq: r.seq, prev, type: r.type, data: r.data, at })) !== r.hash) ok = false;
      prev = String(r.hash);
    }
    return { verified: ok, events: rows };
  }
}

const PROVIDERS: Record<string, string> = { crm: 'Mailstream CRM', billing: 'Paygrid billing', carrier: 'Carrier network', helpdesk: 'Helpdesk', mail: 'Customer email', payments: 'Paygrid payments' };
const MODELED: Record<string, string> = {
  'crm.contact.erase': 'Mailstream CRM erases the contact and its marketing history. Cannot be undone at the provider once delivered.',
  'billing.subscription.cancel': 'Paygrid stops the recurring charge. The customer is not told.',
  'carrier.shipment.void': 'The carrier voids the label. A parcel already collected may be returned to the depot.',
  'helpdesk.case.orphaned': 'The helpdesk keeps the case open with no customer to reply to.',
  'mail.order.cancelled': 'The customer receives a cancellation email.',
  'payments.refund.request': 'Paygrid refunds the captured amount to the customer\'s card.',
};
/** Effects outside the database, inferred from the outbox rows the dry run actually wrote. Never executed by a simulation. */
function modeled(effects: Effect[], holdS: number) {
  const by = new Map<string, number>();
  for (const e of effects) if (e.tbl === 'outbox' && e.op === 'INSERT') by.set(String(e.after!.topic), (by.get(String(e.after!.topic)) ?? 0) + 1);
  return [...by].map(([topic, count]) => ({ topic, count, provider: PROVIDERS[topic.split('.')[0]] ?? 'unknown', consequence: MODELED[topic.replace(/\.compensate$/, '')] ?? 'A compensating message to the provider.', hold_s: holdS }));
}
const UNKNOWN = [
  'Copies outside this database: backups, replicas, PostgreSQL WAL, analytics exports. SOUNDING cannot see or erase them.',
  'What each provider does after it receives a message (the modeled effects above are this shop\'s documented contracts, not observations).',
  'Writes by systems that bypass this service and its triggers.',
];

export function mask(email: string) { const [u, d] = email.split('@'); return `${u.slice(0, 2)}***@${d}`; }
/** E-mail addresses masked, at the top level and inside an outbox payload (Codex R7-9); workspace_id dropped. */
export function maskRow(r: Row): Row {
  return Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'workspace_id').map(([k, v]) => [k,
    k === 'email' && typeof v === 'string' ? mask(v) : k === 'payload' && v && typeof v === 'object' && !Array.isArray(v) ? maskRow(v as Row) : v]));
}

/** Row count and content hash of every business table in the workspace: the state an execution or rollback is judged by. */
export async function stateDigest(q: Q, ws: string): Promise<Digest> {
  const rows = await q<{ t: string; n: number; h: string }>(TABLES.map((t) =>
    `select '${t}' as t, count(*)::int as n, coalesce(md5(string_agg(x::text, ',' order by x.id)), '') as h from ${t} x where workspace_id = $1`).join(' union all '), [ws]);
  const tables = Object.fromEntries(rows.map((r) => [r.t, { rows: r.n, md5: r.h }]));
  return { digest: sha(canonical(tables)), tables };
}

/** The current version (xmin) of each row: either the rows a journal says were changed, or the rows a binding lists. */
export async function rowVersions(q: Q, ws: string, journal: Journal | null, bound?: Versions): Promise<Versions> {
  const want = new Map<string, Set<string>>();
  if (journal) for (const j of journal) if (j.old_row) { const s = want.get(j.tbl) ?? new Set(); s.add(String(j.old_row.id)); want.set(j.tbl, s); }
  if (bound) for (const [t, m] of Object.entries(bound)) want.set(t, new Set(Object.keys(m)));
  const out: Versions = {};
  for (const [t, ids] of want) {
    if (!TABLES.includes(t as Table)) continue;
    const rows = await q<{ id: string; v: string }>(`select id, xmin::text as v from ${t} where workspace_id = $1 and id = any($2)`, [ws, [...ids]]);
    out[t] = Object.fromEntries(rows.map((r) => [r.id, r.v]));
  }
  return out;
}
function diffVersions(a: Versions, b: Versions) {
  const out: string[] = [];
  for (const [t, m] of Object.entries(a)) for (const [k, v] of Object.entries(m)) if (b[t]?.[k] !== v) out.push(`${t}:${k}${b[t]?.[k] === undefined ? ' (gone)' : ''}`);
  return out;
}
const countVersions = (v: Versions) => Object.values(v).reduce((s, m) => s + Object.keys(m).length, 0);
