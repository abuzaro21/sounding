**Pick A: consequence-aware bulk changes.** Its strongest claim is falsifiable: “We ran your deletion, discovered consequences, discarded it, and will reject execution if reality differs.”

Scores below are architectural judgments, not measured results.

| Criterion, 1–5; higher is better | A: Bulk DB changes | B: App + migration deployment | C: Workspace access revocation |
|---|---:|---:|---:|
| Simulation changes the decision | 5 | 4 | 4 |
| Realism | 5 | 5 | 5 |
| Actual effect measurement | 5 | 3 | 4 |
| Technical correctness achievable | 4 | 3 | 4 |
| Demonstrable rollback | 5 | 2 | 4 |
| Unexpected-side-effect coverage | 5 | 3 | 4 |
| Live demo reliability | 5 | 3 | 5 |
| First-30-second wow | 4 | 5 | 4 |
| Operational safety | 5 | 3 | 5 |
| Solo feasibility, three weeks | 5 | 2 | 5 |
| **Total / 50** | **48** | **33** | **44** |

B faces migration irreversibility, environment fidelity and application compatibility beyond a database transaction. C would revoke actual permissions and sessions in an isolated application; regranting access compensates, but cannot resurrect revoked sessions safely.

A gives the clearest demonstration of measured consequences and transactional recovery. Its limitation: a controlled database is a narrower world than an arbitrary business system. State that explicitly.

**Architecture B: a closed-world mutation service**

Use one Node 24/TypeScript service, serving the React/Vite build and API, with one PostgreSQL database. “Real” means committed PostgreSQL changes with actual constraints and triggers; synthetic records do not make those changes mocks.

The flow:

1. Visitor creates an isolated synthetic shop after previewing its provisioning effects.
2. Visitor requests an action through constrained language or editable controls.
3. A deterministic compiler produces an allowlisted action such as `delete_inactive_customers(cutoff, exclusions)`. Ambiguity requires clarification. No SQL generation or paid inference.
4. Simulation executes the real mutation, captures consequences, then rolls back.
5. UI presents affected customers, dependent records, financial exposure, trigger writes and recovery limits.
6. Policy blocks unsafe scope and offers a visibly narrower proposal. That proposal receives its own simulation.
7. Human approves the exact proposal and evidence.
8. Execution repeats the mutation, verifies consequences before commit, and either commits everything or rolls back everything.

Expose a few composable actions, not one hardcoded sentence. Keep the same compiler and executor behind every route, including restoration, reset and cleanup.

**Measuring effects:** install trusted `AFTER ROW` audit triggers on every domain table. Record table, tenant, primary key, operation and complete `OLD`/`NEW` JSON. This captures FK cascades and trigger-generated DML because those writes fire the affected tables’ triggers too. Preserve repeated changes to the same row; distinct-row counts alone lose information.

The journal is transactional. Read it before rollback, retain evidence in application memory, then persist the proposal afterward as bookkeeping. Journal tables do not recursively audit themselves.

This is comprehensive only within the controlled schema. Prohibit `TRUNCATE`, DDL, foreign tables, unreviewed functions and trigger disabling. Verify a schema/function/trigger manifest. Runtime credentials cannot alter that manifest or write the journal directly.

Use stable action-derived identifiers and a fixed logical action timestamp for generated domain records. Otherwise random IDs and timestamps make exact replay comparison meaningless.

**Dependencies and policy:** combine catalog FK relationships with measured writes. Protect settled invoices/payments, active subscriptions, unresolved shipments and support cases. Show paths such as customer → order → line and trigger → outbox. Enforce tenant row quotas, effect-count limits and statement/lock timeouts. Estimate database work; do not invent dollar precision.

**Concurrency:** every domain writer first locks a persistent tenant-control row and advances its revision. Enforce this through trusted database functions/triggers, including internal writers. Simulation and execution use short `SERIALIZABLE` transactions. Retry serialization failures through fresh simulation when evidence changes.

At execution, acquire the tenant lock, validate revision and manifest, run the mutation, flush deferred constraints, compare the complete effect journal and final postconditions, then commit. A mismatch aborts. Approval does not hold locks while the human thinks.

**Recovery:** commit deletion evidence and an idempotent action receipt atomically with the deletion. Offer restoration only for supported records: insert original keys and values in dependency order, reject conflicts, and remove/cancel only compatible pending outbox effects. Restoration itself requires simulation and approval. No external outbox dispatcher in this prototype; delivered external effects would require additional compensation.

**Hosting and storage:** share the supplied free Render PostgreSQL allocation across tenants; do not provision one DB per visitor. Cap active tenants and dataset sizes well below 1 GB, rate-limit provisioning, and implement bounded expiration cleanup. Treat the 30-day expiry as destructive: document recreation and reseeding. Keep connection pools small. Warm the demo before recording, while disclosing free-service startup delays.

**PostgreSQL hard questions**

**a. Same mutation?** Yes: one executor, one compiled action, identical SQL and trigger code. Only the transaction conclusion differs. Separate “count-only simulation SQL” is insufficient.

**b. Guaranteed discarded?** Transactional row changes and journal entries disappear after a successful `ROLLBACK`. That is not universal erasure: sequence operations, consumed transaction IDs, logs and resource usage survive. Session advisory locks survive rollback; transaction advisory locks release. Temporary spill files are not an evidence-erasure guarantee. Transactional temporary-object changes follow transaction rules. Pending `NOTIFY` messages are delivered only on commit. Independently committed `dblink` work survives.

**c. External side effects?** PostgreSQL functions, extensions or remote connections can produce them. A rollback cannot retract an HTTP request. Use a curated trigger/function set, prohibit remote execution paths, and restrict privileges. A database transaction alone provides no external-side-effect guarantee.

**d. Changing state?** Yes. The locked tenant revision detects intervening domain writes, provided every writer participates. `xmin` detects changes to existing tuples; it misses newly inserted matching rows—phantoms—and is unsuitable as a permanent application version. `SERIALIZABLE` protects each transaction, not the interval between two transactions.

**e. Approval binding?** Store server-side: tenant and actor, action ID, normalized parameters, exclusions, executor/build version, schema manifest, tenant revision, policy version/result, logical time, canonical complete effect evidence, recovery scope, expiry and single-use status. Hash canonical evidence; never trust browser-supplied evidence. Execution must still verify current state.

**f. Indirect/deferred effects?** Auditing captures controlled DML. Run `SET CONSTRAINTS ALL IMMEDIATE` after the final mutation, before final journal inspection; outstanding deferred constraint triggers fire, and subsequent relevant checks remain immediate. Add no domain writes afterward. Changed triggers invalidate approval through manifest checks; deployment must coordinate schema changes with active transactions. Background jobs are separate transactions: disable dispatch here and require any internal writer to use the same revision/approval discipline.

**g. Partial results from failure?** One local transaction cannot partially commit its ordinary row changes. Do not catch a mutation error and commit remaining work. Separate connections and external effects violate that boundary. A lost connection during commit creates an **unknown outcome**, resolved through the atomic action receipt—not an automatic “rolled back” banner.

**h. Proof of rollback?** Show journal evidence of attempted changes, then query affected tables through an independent connection after rollback. Assert original records remain, collateral records are absent and no committed receipt exists. Show sequence advancement separately if sequences are used.

**i. More than confirmation?** The first proposal must visibly fail policy because measured consequences exceed the request. The narrower proposal must have different measured effects. Approval authorizes that evidence, not merely an English sentence.

**j. Visitor isolation?** Use tenant-qualified keys and composite FKs, RLS with `FORCE ROW LEVEL SECURITY`, and a runtime role without ownership, superuser or `BYPASSRLS` privileges. Set tenant context transaction-locally from authenticated server context. Review `SECURITY DEFINER` functions with fixed safe `search_path`. Superusers can bypass RLS; application isolation cannot constrain the database administrator.

**k. Beyond the script?** Demonstrate changed cutoffs, exclusions, randomized datasets, rejected financial dependencies and restoration conflicts. Publish the action grammar and its limits.

**Two honest under-prediction failures**

1. **A new dependency appears after simulation.** Simulate deleting an eligible customer. A separately approved action creates an unpaid order referencing that customer. Existing customer `xmin` remains unchanged, but the tenant revision changes. Execution rejects the stale approval before deletion. The earlier simulation accurately described its snapshot; the downstream state guard catches newly possible consequences.

2. **A time-dependent trigger crosses a cutoff.** A visible, documented trigger creates an extra internal escalation outbox row when `clock_timestamp()` passes a stored deadline. Simulate before that deadline; execute afterward. The same trigger runs both times. Revision and schema checks pass because no stored state changed, but execution’s journal contains the additional row. Exact-effect verification rolls back the deletion and escalation together.

For scenario 2, rerun simulation after the deadline and prove it observes the escalation. Never branch on “simulation mode,” disable auditing or hide a trigger. This demonstrates a limit of snapshot prediction, not a defective observer.

Reproducible tests should assert journals, independent final state and receipts. Also test cascades, repeated row updates, deferred triggers, schema invalidation, concurrent inserts, tenant attacks, restore conflicts, serialization retries and ambiguous commit recovery.

**Names**

Ratings: clarity/relevance/visual potential, 1–5. Collision estimates are unverified.

| Name | Tagline | Ratings | Collision risk |
|---|---|---|---|
| **EffectLedger** | See every consequence before you commit. | 5/5/4 | Medium |
| ConsequenceMap | Know who and what your action reaches. | 5/5/5 | Medium |
| ScopeProof | Approve the scope you can prove. | 4/5/4 | Medium |
| CascadeLens | Reveal what changes downstream. | 4/5/5 | Medium |
| BeforeCommit | Run the consequences before committing. | 5/5/3 | High; common software phrase |
| Undertow | See what your action pulls with it. | 3/5/5 | High; established Undertow web server |

Pick **EffectLedger**: clear consequences plus an inspectable record. **UNDERTOW** has the strongest visual metaphor, but its danger-oriented tone and established software collision weaken discoverability. Use the surface/undertow idea in the video even with another name.

**Ten skeptical attacks—and defenses**

1. **“Your preview is fabricated.”** Publish the shared executor; expose captured row evidence and reproducible SQL-level tests.
2. **“Those are only direct deletes.”** Demonstrate FK cascades, trigger inserts and deferred-trigger writes with asserted journals.
3. **“Approval is already stale.”** Tenant revision, locked execution, manifest binding and final-effect comparison.
4. **“A hidden job escapes verification.”** No dispatcher; enumerate every writer and show its enforced mutation path.
5. **“Rollback means a reassuring toast.”** Independent post-rollback queries and absent committed receipts.
6. **“Restore overwrites newer work.”** Strict conflict detection, bounded recovery scope and separately approved compensation.
7. **“I can delete someone else’s shop.”** Composite FKs, forced RLS and adversarial cross-tenant API/database tests.
8. **“I can inject SQL or exhaust the database.”** Structured actions, parameterized SQL, quotas, provisioning limits and timeouts.
9. **“A timeout secretly committed twice.”** Atomic receipts, unique action IDs, single-use approvals and outcome reconciliation.
10. **“It works only during your recording.”** Clean-clone setup, deterministic seeds, repeatable failure tests and an independently usable live deployment.

For the 90-second video: broad request → surprising dependency map → blocked proposal → narrower approval → real committed deletion → restoration → cutoff failure caught. The architecture snapshot should show transaction boundaries and external-effect exclusions. The 300-word thesis should argue that consequence awareness requires measured effects, explicit uncertainty and enforceable recovery.

Not checked: current hosting behavior, name availability or implementation; this review used only the brief.
Principal risk: the guarantees depend on a closed schema and complete control of every writer and trigger.