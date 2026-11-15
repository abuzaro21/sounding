// Thin client for the SOUNDING API. Every mutation carries the custom header the server requires (CSRF).
export type Op = 'INSERT' | 'UPDATE' | 'DELETE';
export type Cause = 'direct' | 'cascade' | 'set_null' | 'trigger' | 'restore';
export type Row = Record<string, unknown>;
export type Effect = { key: string; tbl: string; id: string; op: Op; cause: Cause; seq: number; before?: Row; after?: Row };
export type Finding = { rule: string; severity: 'block' | 'warn'; title: string; detail: string; roots: string[]; rows: { tbl: string; id: string; note: string }[] };
export type Policy = { verdict: 'safe' | 'blocked'; version: string; findings: Finding[] };
export type Spec = { template: string; params: { months?: number; days?: number; execution_id?: string }; exclude: string[]; target_ids: string[]; mode: string };
export type Action = {
  id: string; parent_id: string | null; origin: string; intent: string; spec: Spec; spec_hash: string; status: string; created_at: string;
  expectation: { rows: number; table: string; statement: string }; rationale: string | null;
};
export type Target = { id: string; name: string; email: string; status: string; at: string; total_cents?: number; blocked_by: string[] };
export type Modeled = { topic: string; provider: string; count: number; hold_s: number; consequence: string };
export type Report = {
  policy: Policy; expectation: Action['expectation']; ms: number; isolation: string; root_table: string;
  summary: { total: number; causes: Partial<Record<Cause, number>>; tables: Record<string, { deleted: number; updated: number; inserted: number }> };
  durable: { unchanged: boolean; state_before: string; state_after: string; journal_rows_in_dry_run: number; journal_residue_after_rollback: number; deliveries_before: number; deliveries_after: number };
  modeled: Modeled[]; unknown: string[]; targets: Target[]; predicate_now: number | null;
};
export type Simulation = { id: string; action_id: string; verdict: 'safe' | 'blocked'; created_at: string; effect_digest: string; schema_fp: string; report: Report; effects: Effect[] };
export type Approval = { id: string; nonce: string; expires_at: string; binding: Record<string, string | number> };
export type Check = { name: string; ok: boolean; detail: string };
export type Receipt = {
  status: 'committed' | 'rolled_back' | 'refused'; reason: string; next?: string; checks: Check[]; isolation: string;
  pre_state?: string; post_state?: string; state_restored?: boolean; intact?: { intact: number; checked: number }; journal_residue?: number;
  approved_digest?: string; policy?: Policy | null; effects?: number; ms?: number;
  comparison?: { counts: { unexpected: number; missing: number; changed: number }; unexpected: Effect[]; missing: Effect[]; changed: { approved: Effect; actual: Effect; columns: string[] }[] } | null;
};
export type Execution = { id: string; action_id: string; approval_id: string; simulation_id: string; status: Receipt['status']; receipt: Receipt; recovery_status: string | null; recovery_expires_at: string | null; created_at: string };
export type State = {
  workspace: string; digest: string; tables: Record<string, number>; ledger_mirroring: boolean; deliveries: number; hold_s: number;
  outbox: { id: string; topic: string; aggregate: string; status: string; created_at: string; dispatched_at: string | null }[];
  executions: { id: string; action_id: string; status: string; reason: string; recovery_status: string | null; recovery_expires_at: string | null; created_at: string }[];
};
export type Session = { workspace: string; created: boolean; operator: string; examples: string[]; rules: Record<string, string>; policy: string };
export type Drift = { kind: string; text: string };
export type AuditLog = { verified: boolean; events: { seq: number; at: string; type: string; data: Row; hash: string }[] };

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'POST' ? { 'content-type': 'application/json', 'x-sounding': '1' } : {},
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error ?? 'error', data.message ?? `Request failed (${r.status}).`);
  return data as T;
}

export const api = {
  session: () => call<Session>('POST', '/api/session'),
  state: () => call<State>('GET', '/api/state'),
  audit: () => call<AuditLog>('GET', '/api/audit'),
  reset: () => call<{ ok: true }>('POST', '/api/reset'),
  propose: (b: { intent?: string; template?: string; params?: Spec['params']; exclude?: string[] }) => call<Action>('POST', '/api/actions', b),
  action: (id: string) => call<Action>('GET', `/api/actions/${id}`),
  simulate: (actionId: string) => call<Simulation>('POST', `/api/actions/${actionId}/simulate`),
  simulation: (id: string) => call<Simulation>('GET', `/api/simulations/${id}`),
  edit: (actionId: string, b: { months?: number; days?: number; exclude?: string[]; include?: string[] }) => call<Action>('POST', `/api/actions/${actionId}/edit`, b),
  revise: (simId: string) => call<Action>('POST', `/api/simulations/${simId}/revise`),
  approve: (simId: string) => call<Approval>('POST', `/api/simulations/${simId}/approve`),
  reject: (simId: string, reason?: string) => call<Row>('POST', `/api/simulations/${simId}/reject`, { reason }),
  execute: (approvalId: string, nonce: string) => call<Execution>('POST', `/api/approvals/${approvalId}/execute`, { nonce }),
  execution: (id: string) => call<Execution>('GET', `/api/executions/${id}`),
  restore: (execId: string) => call<Action>('POST', `/api/executions/${execId}/restore`),
  drift: (kind: string) => call<Drift>('POST', '/api/drift', { kind }),
  records: (table: string, ids: string[]) => call<Row[]>('GET', `/api/records?table=${encodeURIComponent(table)}&ids=${ids.map(encodeURIComponent).join(',')}`),
};

export const short = (h?: string, n = 8) => (h ? h.slice(0, n) : '—');
export const money = (c: number) => `$${(c / 100).toFixed(2)}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
