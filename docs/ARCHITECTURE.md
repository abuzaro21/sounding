# Architecture

SOUNDING is one Node 24 process and one PostgreSQL 16 database. There is no queue, cache, worker service or model API. The simulator is the database's own transaction machinery, so the dry run executes the same code path as the real change.

```
 browser (React 19, Vite)                     node:http  (src/http.ts)
 ┌──────────────────────────┐   JSON + cookie  ┌───────────────────────────────────────────────┐
 │ Composer → Canvas → Diff │ ───────────────▶ │ session, CSRF header, rate limits, masking    │
 │ Verdict → Decision       │                  │                                               │
 │ Receipt / Incident       │ ◀─────────────── │ Engine (src/engine.ts)                        │
 └──────────────────────────┘                  │   compile ─ propose ─ simulate ─ approve      │
                                               │   execute ─ verify ─ restore ─ audit          │
                                               │       │            │                          │
                                               │  agent.ts     templates.ts   policy.ts        │
                                               │  (compiler,   (resolve /     (rules over      │
                                               │   reviser)     lock / apply)  measured        │
                                               │                               effects)        │
                                               │  effects.ts (journal → effects, digest)       │
                                               │  dispatcher: the only background writer       │
                                               └──────────────────────┬────────────────────────┘
                                                                      │ role `app`: NOSUPERUSER NOBYPASSRLS
                                               ┌──────────────────────▼────────────────────────┐
                                               │ PostgreSQL 16                                 │
                                               │  12 business tables, RLS FORCE per workspace  │
                                               │  zzz_capture trigger on each → change_log     │
                                               │  domain triggers → outbox → deliveries        │
                                               │  actions, simulations, approvals, executions, │
                                               │  audit (hash chain)                           │
                                               └───────────────────────────────────────────────┘
```

## Source map

| File | Responsibility |
|---|---|
| `src/schema.ts` | DDL. Business tables keyed `(workspace_id, id)` with composite FKs, so a cascade cannot cross tenants. The deliberately imperfect FK actions (cascade, `SET NULL`, referral self-FK). Domain triggers that write outbox messages. The `zzz_capture` journal trigger and the RLS policies. |
| `src/seed.ts` | Deterministic synthetic data per seed (`rng`). |
| `src/db.ts` | `Db.tx`: one transaction with `snd.ws`, `snd.capture`, `snd.action`, statement, lock and idle timeouts set as transaction-local settings. Supports `rollbackOnly`, isolation level and a `beforeCommit` test hook. Maps a lost COMMIT to `CommitUnknown`. |
| `src/agent.ts` | The action compiler (plain words to a template and bounded parameters), the agent's naive expectation, and the reviser that narrows a blocked plan. |
| `src/templates.ts` | The only mutations that exist: `purge_inactive_customers`, `cancel_stale_orders`, and `RESTORE`. Each has `resolve` (selection to frozen ids), `lock`, `direct` and one `apply` that both simulation and execution call. |
| `src/effects.ts` | Journal to effects (`tbl:id:OP#n`, cause, before/after images, changed columns), the canonical effect digest, and the approved-vs-actual comparison. |
| `src/policy.ts` | Rules `larkspur-2026.11-r1`, evaluated only over measured effects. Attribution of each effect to the target that caused it. |
| `src/engine.ts` | Orchestration: workspaces, propose, simulate, approve, execute and verify, failure receipts, restore, drift, dispatcher, audit chain, read model. |
| `src/http.ts` | The public surface. Sessions, CSRF header, rate limits, body limits, id validation, response masking, static files. |
| `src/main.ts` | Wiring, environment, the dispatcher interval, idle purge, start-up reconciliation of interrupted executions. |
| `ui/src/*` | The consequence canvas, before/after diff, decision panel, receipt, incident dialog, outbox and audit views. |
| `scripts/eval.ts` | The 40-scenario evaluation that writes `docs/evidence/eval.json`. |
| `scripts/live-check.ts` | 18 HTTP checks against any deployment. |

## Data model

Business tables (per workspace): `customers`, `addresses`, `products`, `orders`, `order_lines`, `invoices`, `payments`, `shipments`, `subscriptions`, `support_cases`, `ledger_entries`, `outbox`. `settings` holds the ledger-mirroring switch, and `deliveries` records what the dispatcher "sent".

Control tables: `workspaces`, `change_log` (the capture journal), `actions`, `simulations`, `approvals`, `executions`, `audit`. Every one cascades from `workspaces`, so Reset and idle purge leave no residue (tested).

## Request flow

| Step | Endpoint | Engine | Writes |
|---|---|---|---|
| Intent | `POST /api/actions {intent}` | `compile` → `resolve` → frozen `target_ids` | `actions` (`proposed`) |
| Simulate | `POST /api/actions/:id/simulate` | rollback-only REPEATABLE READ tx, measured journal, policy | `simulations` (effects, digest, row versions, schema fp, proof) |
| Modify (agent) | `POST /api/simulations/:id/revise` | `revise` excludes the attributed roots | old action `superseded`, new action |
| Modify (human) | `POST /api/actions/:id/edit` | new scope or exclusions | old action `superseded`, new action |
| Reject | `POST /api/simulations/:id/reject` | | action `rejected`, approvals revoked |
| Approve | `POST /api/simulations/:id/approve` | safe + fresh + latest only; HMAC binding, nonce | `approvals` (`approved`) |
| Execute | `POST /api/approvals/:id/execute {nonce}` | claim once, SERIALIZABLE, lock, verify, commit or roll back | `executions` receipt, journal kept as recovery record |
| Restore | `POST /api/executions/:id/restore` | a new action through the same gate | `actions` (`restore_execution`) |
| Drift | `POST /api/drift {kind}` | ordinary business write in the visitor's workspace | business rows |

Every step appends to the per-workspace audit hash chain.

## What runs in the background

Only the outbox dispatcher (`Engine.dispatch`, every 5 s). It marks committed `pending` messages older than the hold window (60 s) as `dispatched` and writes a `deliveries` row. It uses `FOR UPDATE SKIP LOCKED` and can never see uncommitted rows, so a simulation's queued messages cannot leak (tested: `deliveries_before == deliveries_after` in every proof). The idle purge deletes workspaces unseen for 12 h and expires recovery records past their window.
