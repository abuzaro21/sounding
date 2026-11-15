# Architecture A (Claude) — written before reading Codex's Architecture B

## 1. Concept competition

Scores 1–5. Feasibility = a solo builder, ~3 weeks, free hosting.

| Criterion | A. Bulk DB change | B. Deploy + migration | C. Payment-refund batch to a sandbox PSP |
|---|---|---|---|
| Simulation changes the decision | 5. Cascades reveal open obligations | 4. A failing migration blocks the deploy | 4 |
| Realism | 5. Every company has done a `DELETE … WHERE` | 5 | 4 |
| Exact effect measurement | 5. Row triggers inside the tx see every change | 3. App behaviour is hard to diff exactly | 2. A third-party sandbox is a black box |
| Technical correctness | 5. PostgreSQL transactional semantics | 3 | 2 |
| Demonstrable rollback | 5. Real `ROLLBACK`, plus restore from before-images | 3. Down-migrations are often lossy | 2. Refund reversals are not undo |
| Unexpected-side-effect coverage | 5. Triggers, cascades, SET NULL, outbox | 4 | 3 |
| Live demo reliability | 5. One service and one DB | 2. Needs build infrastructure per visitor | 2. Depends on a third party |
| First-30-second wow | 4. "64 rows asked, 640 rows affected" | 4 | 3 |
| Operational safety | 5. Synthetic tenant only | 3 | 3 |
| Feasibility | 5 | 2 | 3 |
| **Total** | **49** | **33** | **28** |

**Pick: A.** It is the only option where the simulator can be the actual mutation, run in the actual engine.
The effect measurement is exact rather than modelled, and the rollback is the database's own guarantee.
B and C would both need a "simulation" that is really a model of a system we cannot fully observe.

## 2. Name

UNDERTOW. What the agent asks for is the surface. Cascades, triggers and orphaned obligations are the undertow that drags other records along.

Visual system: a waterline, with the requested change drawn above it and everything it pulls drawn below. The consequence canvas is literally split by that line.

Alternates considered:
- ACTSHADOW (awkward)
- PENUMBRA (obscure)
- BLASTRADIUS (aggressive; widely used devops jargon)
- DRYDOCK (Docker confusion)
- FORESHADOW (generic word)

## 3. System being modified

A fictional outdoor-gear retailer, "Larkspur Outfitters", stored in real PostgreSQL 16. It has 12 business tables, all keyed `(workspace_id, id)` with composite FKs, so a cascade cannot cross tenants.

```
customers, addresses, orders, order_lines, invoices, payments, shipments,
subscriptions, support_cases, outbox, products/stock (for the second action)
```

The FK actions are deliberately those of a real, imperfect legacy schema:
- `orders`, `invoices`, `payments`, `shipments`, `subscriptions` and `addresses` use `ON DELETE CASCADE`.
- `support_cases.customer_id` uses `ON DELETE SET NULL`, which orphans the case.
- `customers.referred_by` is a self-FK with `ON DELETE SET NULL`, which silently edits *active* customers.
- A `BEFORE/AFTER DELETE` trigger on `subscriptions` and `shipments` writes outbox events. These are messages to billing and carrier providers.

## 4. Pipeline

Intent text → **compiler** → ActionSpec. The compiler is an allowlisted grammar and templates, never SQL.
The ActionSpec is `{template, params, target_ids (frozen), mode}`.

**Simulation tx:**
```
BEGIN
  SET LOCAL statement_timeout, lock_timeout
  set_config('ut.capture','<sim id>',true)
  set_config('ut.ws',ws,true)
  run template.apply(q, spec)            -- the SAME function execution uses
  SET CONSTRAINTS ALL IMMEDIATE          -- flush deferred constraint triggers
  read change_log WHERE txid = txid_current()
ROLLBACK
```
`zz_capture` is an AFTER ROW trigger on every business table. It records `(tbl, op, pk, old jsonb, new jsonb)` into `change_log`, but only when `ut.capture` is set in this tx.
- **Coverage check:** every business table must have the capture trigger enabled, or simulation and execution refuse to run.
- **Durability proof:** the per-table state digest of the workspace is computed before and after. The change_log residue must be 0, and outbox deliveries must be unchanged.

**Effect classes:**
- *Observed*: rows changed in the dry run.
- *Modelled downstream*: what dispatching each observed outbox row would do externally. This is inferred from the topic and never executed.
- *Unknown*: backups, analytics copies, provider logs, WAL. These are listed, not quantified.

**Policy** (versioned, deterministic) runs over the observed effects:
- **INV-1 open obligation.** Deletes must not touch an unpaid invoice, a pending shipment, an active subscription or an open case.
- **INV-2 financial retention.** No invoice or payment younger than 7 years may be deleted.
- **WARN-1 collateral edit.** A non-target customer is modified.
- **Limits.** Targets ≤ 200 and effects ≤ 5,000.

A violation blocks approval on the server. The **agent** (deterministic planner) reads the violation evidence and proposes a revision: it excludes the implicated target IDs and re-simulates, up to 3 rounds.
The agent's own a-priori expectation is shown next to reality. It knows only the target table and predicts N rows, which shows how incomplete a projection is.

**Approval** is a server row bound to:
- workspace and operator session
- spec hash, simulation id and effect digest
- row-version map (`xmin` of every observed row) and schema fingerprint (catalog digest of tables, constraints and triggers)
- policy version
- expires_at (10 min) and a one-time nonce

There is one live approval per simulation (partial unique index). Modifying the action creates a new action and simulation, so an old approval can never match.

**Execution:**
1. A short tx claims the approval with `UPDATE … status approved → executing`. Only one caller wins.
2. The execution tx then runs:
```
BEGIN (READ COMMITTED)
  pg_advisory_xact_lock(ws)
  schema fingerprint == bound            else REFUSE (stale schema)
  SELECT … FOR UPDATE target rows ORDER BY id
  xmin of every bound row == bound       else REFUSE (stale rows)
  pre-state digest + per-table counts
  template.apply(same spec, frozen target ids)
  SET CONSTRAINTS ALL IMMEDIATE
  actual = change_log(txid)
  verify:
    actual effect keys+values == approved
    counts delta == net of actual
    policy(actual) passes
  ok → write recovery record + receipt, delete change_log rows, COMMIT
  else → ROLLBACK
```
3. After a rollback, a separate tx writes the failure receipt and re-measures the state digest. It must equal the pre-state digest.

The `FOR UPDATE` row lock blocks concurrent FK inserts against the targets, since they need a KEY SHARE lock on the parent. So no new dependency can appear *during* execution.

The `xmin` check catches updates and delete-plus-reinsert. It **cannot** see phantoms, i.e. new child rows. Those are caught only by the verifier. That is the honest failure scenario.

## 5. Failure scenarios

1. **Phantom dependency (main demo).** The safe plan is approved. A business process then places a new order for one of the target customers, committed normally.
   - The pre-check passes, because the customer's `xmin` is unchanged.
   - The cascade deletes the new order, its lines and its invoice. The verifier sees unapproved effects and an INV-1 violation, so it rolls back.
   - The receipt shows the pre and post digests are equal. The operator re-simulates and the agent excludes the customer.
2. **Trigger added after simulation (schema drift).** A migration adds an audit-ledger trigger.
   - The schema fingerprint refuses the execution.
   - With that check disabled (test-only hook), the verifier still catches the extra ledger rows and rolls back. This is defence in depth, proven separately.
3. **Updated row.** A support agent reopens a case. Its `xmin` has changed, so the stale pre-check refuses before any mutation.

## 6. Recovery

Committed purges are *recoverable deletions*. The execution's before-images are kept as a recovery record for 24 h, and the UI says so.

Restore is itself an action, `restore_execution`, and goes through the same simulate → approve → execute → verify pipeline. The inverse operations are:
- re-insert deleted rows parent-first
- revert updated rows, but only if the current value still equals the after-image
- cancel undispatched outbox rows
- add compensating events for dispatched ones

Conflicts (a key reused, a row changed since, the window expired) block the restore. Already-delivered external messages are irreversible, and the UI says so.

## 7. Isolation and safety

- Every business table has FORCE ROW LEVEL SECURITY on `current_setting('ut.ws')`.
- Composite FKs, plus explicit `workspace_id = $1` in every query.
- The app role is not a superuser; superusers bypass RLS, and the health check reports it.
- A cookie session owns exactly one workspace. Reset deletes and reseeds only that workspace.
- There is no SQL, DB URL or path input anywhere.
- Rate limits per IP; a global simulation semaphore; statement and lock timeouts; a cap on workspace count; TTL purge.

## 8. Stack

- Node 24 + TypeScript (type stripping), plain `node:http`, `pg`, React/Vite UI, `node:test` and Playwright.
- PostgreSQL 16 in a dedicated local Docker container. CI uses a GitHub service container. Render free web service plus free PG.
- No ORM: explicit SQL and transaction control are the point.
- No LLM. A deterministic planner keeps the demo honest and free.
