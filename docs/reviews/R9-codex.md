# Codex review R9: final diff review of the R2–R8 fixes

| | |
|---|---|
| Reviewer | Codex CLI, model `gpt-6.1-sol` (from the run's own header), provider openai |
| Mode | `sandbox: read-only`, `approval: never`, reasoning effort high |
| Session | `01a1e0b4-6ffa-7da3-818e-505d81021f11` |
| Reviewed | commit `60b23b7` (the fixes for R2–R8), diffed against `42faa18` |
| Prompt | [R9-codex.prompt.md](R9-codex.prompt.md) |

**Every fix below was made after this review, in commit `9f31314`, and was not reviewed by Codex.** Their evidence is the tests named here.

## Triage

| Finding | Claim | Verdict | Change | Test |
|---|---|---|---|---|
| 1 High | Rewrite rules escape coverage and fingerprint | Confirmed. Fixed | A rewrite rule on a bookkeeping table blocks; every non-view rule is fingerprinted | `a table outside the journalled set … stops the simulation` (rule on `executions`) |
| 2 High | FK reach ignores other schemas | Confirmed. Fixed | Reach is resolved across all schemas; a reachable unjournalled table in any schema blocks | same test (`zz_other.loyalty_cards`) |
| 3 High | Older databases never get the new constraints | Confirmed. Fixed by refusal, not migration | Every record is synthetic, so start-up refuses a database that lacks the new constraints and asks for it to be recreated | none automated (the guard is plain DDL; checked by reading `src/schema.ts`) |
| 4 High | Approvals and executions uncapped after a refusal | Confirmed. Fixed; concurrency part **accepted** | One approval per simulation, failed ones included: after a refusal only a new simulation can be approved, so approvals and executions are bounded by the simulation quota. Concurrent requests can overshoot a quota by at most the 3 admitted operations; accepted and documented in SECURITY | FAILURE TEST 1 asserts that re-approval is refused |
| 5 Medium | External Render URL without `sslmode` is plaintext | Confirmed. Fixed | A `*.render.com` URL without `sslmode=require/verify-ca/verify-full` is refused at start-up | `an external Render database URL must request TLS` |
| 6 Medium | Failure receipt written outside the lock | Confirmed. Fixed | Terminal receipt and approval update are one transaction under `exec:<ws>`, with `on conflict (approval_id) do nothing`; if a receipt already exists, it is returned | race tests still pass; this exact interleaving is not reproduced |
| 7 Medium | Recovery calls any receipt "committed" | Confirmed. Fixed | Recovery reads the receipt status: committed consumes, anything else fails with that status | `reconciliation follows the receipt …` |
| 8 Medium | Older simulation revokes a newer approval | Confirmed. Fixed | A simulation revokes approvals of strictly older ones only, ordered by `(created_at, id)`; approve uses the same order | none specific (interleaving not reproduced by timing) |
| 9 Medium | 8 s statement timeout cuts the 30 s wait; no later reconciliation | Confirmed. Fixed | `statementMs: 35 000`; reconciliation also runs every 60 s for approvals that expired more than 2 minutes ago | `reconciliation follows the receipt …` (age filter) |
| 10 Medium | Busy lock aborts start-up | Confirmed. Fixed | A lock timeout (55P03) defers that approval to the next pass instead of failing start-up | `reconciliation defers an approval whose execution lock is held …` |
| 11 Low | Restore receipt omits irreversible effects | Confirmed. Fixed | Committed restoration receipts carry `irreversible` | `after messages were delivered …` asserts it |

## Codex output, verbatim

Local absolute paths in links were made repository-relative; nothing else was changed.

Not all “Fixed” claims are complete. Remaining gaps affect R2-1; R6-2/3/6/7; and R7-1/2/7. Here, R6 numbers refer to the combined R4/R5/R6 triage table.

1. **High — [src/db.ts:101](src/db.ts:101): Rewrite rules can introduce unapproved writes after verification without changing the fingerprint.**  
   **Scenario:** After simulation, add an `ON INSERT TO executions DO ALSO INSERT INTO ledger_entries …` rule. Coverage checks inspect triggers, and the fingerprint omits `pg_rewrite`. Writing the receipt therefore creates an additional ledger entry after verification; execution then deletes its journal entry and commits it. This leaves R6-3 incomplete and contradicts the documentation’s “any schema change” protection.  
   **Smallest fix:** Reject rewrite rules on bookkeeping tables and fingerprint rules on business tables.

2. **High — [src/db.ts:100](src/db.ts:100): FK coverage discards reachable tables outside `current_schema()`.**  
   **Scenario:** Add `other_schema.customer_notes` with an `ON DELETE CASCADE` FK to `customers`. Although recursion reaches its OID, joining against the schema-limited `t` removes it. Its constraints and the parent’s internal FK triggers are also excluded from fingerprinting. Customer deletion can commit unmeasured dependent deletions. R2-1 is only partly fixed.  
   **Smallest fix:** Resolve every reachable OID across namespaces and reject any table outside the captured set.

3. **High — [src/schema.ts:172](src/schema.ts:172): Existing databases never receive the new unique approval constraint or composite FKs.**  
   **Scenario:** Start this commit against a database initialized by `42faa18`. `CREATE TABLE IF NOT EXISTS` skips the changed definitions; `Db.migrate()` contains no corresponding `ALTER TABLE` migration. Cross-workspace references remain possible, and duplicate terminal receipts remain unconstrained. R6-2 and R7-7 therefore hold only for fresh databases.  
   **Smallest fix:** Add an explicit migration installing the new uniqueness and tenant-qualified FKs on existing tables.

4. **High — [src/engine.ts:110](src/engine.ts:110): The quota leaves approval, execution and associated audit history uncapped.**  
   **Scenario:** Make a safe simulation stale through drift, then repeatedly approve and execute that same still-fresh simulation. Each refusal leaves the action proposed; failed approvals are excluded from `approvals_one_live`, so another approval succeeds. Thousands of records can accumulate while simulation/action/drift counters barely move. Quota checks also occur separately from writes, allowing concurrent overshoot. R7-1 remains incomplete; the documented requirement for a new simulation after failure is unenforced.  
   **Smallest fix:** Enforce a budget covering every durable history writer, atomically with its writes.

5. **Medium — [src/db.ts:18](src/db.ts:18): Removing the TLS heuristic downgrades unparameterized external Render URLs to plaintext.**  
   **Scenario:** The original review’s URL shape, `postgres://…@db.example.render.com/db`, now resolves to `ssl: false` in the installed `pg` configuration, confirmed without connecting. It attempts an unencrypted connection instead of requiring authenticated TLS. A server accepting plaintext exposes credentials/data; a TLS-only server rejects the connection. R7-2 is incomplete for that configuration.  
   **Smallest fix:** Require verified TLS for external Render connections, or reject URLs that omit the required TLS configuration.

6. **Medium — [src/engine.ts:453](src/engine.ts:453): Receipt reconciliation releases its lock before terminal failure recording, leaving a duplicate-insert race.**  
   **Scenario:** After an uncertain COMMIT resolves as absent, both receipt lookups return nothing. Startup recovery then records its rollback receipt before `#failed()` inserts another. On a fresh schema, unique `approval_id` turns this into `23505` and HTTP 500 instead of returning the existing receipt. Ordinary failure finalization has the same unlocked window. R6-2/7 remain incomplete.  
   **Smallest fix:** Under the execution and approval locks, atomically look up or insert the terminal receipt and update approval state.

7. **Medium — [src/engine.ts:520](src/engine.ts:520): Recovery labels any existing receipt as a committed execution.**  
   **Scenario:** `#failed()` commits a `refused` or `rolled_back` receipt, then the process dies before its separate approval update. Recovery finds `executing` plus a receipt and sets `consumed`, with outcome “committed.” The receipt and approval now contradict each other.  
   **Smallest fix:** Read the receipt’s status; consume only committed approvals and mark other terminal outcomes failed.

8. **Medium — [src/engine.ts:280](src/engine.ts:280): An older simulation can revoke approval of a newer simulation.**  
   **Scenario:** S1 inserts its simulation row and pauses before revocation. S2 completes, becomes latest, and receives approval. S1 resumes and rejects S2’s approval because its query targets every other simulation, rather than older simulations. This is introduced by the R6-6 fix.  
   **Smallest fix:** Serialize publication and approval creation on the action row, publish/revoke atomically, and revoke only older simulations.

9. **Medium — [src/engine.ts:450](src/engine.ts:450): The advertised 30-second COMMIT reconciliation wait actually times out after eight seconds and can leave no eventual receipt.**  
   **Scenario:** The original backend remains unresolved beyond eight seconds. The replacement transaction inherits `statementMs: 8000`, which expires before `lockMs: 30000`. It returns `outcome-unknown`; if the original subsequently rolls back, approval remains `executing` without a receipt. Reconciliation runs only at startup, so reloading a minute later does not resolve it. This contradicts the error message and concurrency documentation.  
   **Smallest fix:** Set a compatible statement timeout and arrange subsequent reconciliation after an unresolved response.

10. **Medium — [src/engine.ts:514](src/engine.ts:514): Startup recovery aborts server startup when a live execution holds its lock longer than three seconds.**  
    **Scenario:** During overlapping instances, an existing worker has a legitimate execution lasting between three and ten seconds. Recovery inherits the default three-second lock timeout; its rejection escapes through `start()` before the new server listens. The new test releases its parked execution after only 300 ms.  
    **Smallest fix:** Treat recovery lock contention as deferred work and retry it without failing startup.

11. **Low — [src/engine.ts:418](src/engine.ts:418): Committed restoration receipts omit the irreversible-effect information promised by the docs.**  
    **Scenario:** Restore an execution after its messages were dispatched. Policy produces `IRREVERSIBLE` warnings and restoration queues compensations, but the committed receipt stores neither those warnings nor `applied.restore.irreversible`. [docs/ROLLBACK.md:53](docs/ROLLBACK.md:53) and README promise that the receipt identifies what could not be unsent.  
    **Smallest fix:** Include the irreversible list or policy warnings in committed restoration receipts.

### Verified sound

- **R2-2 through R2-7:** Column defaults enter the fingerprint; cancellation aggregates quantities per product; scoring compares keys and images with correct FP/FN accounting; blocked rows are deduplicated; the lost-ack test injects failure after COMMIT; restore counters initialize correctly.
- **R6-1/4/5/8:** Action locking prevents edit/reject overwrites; binding reconstruction recomputes the relevant digests; admission precedes claiming; transport errors carrying codes enter `CommitUnknown`.
- **R6-9/10/11:** Batched inserts address referral cycles; workspace expiry removes retained simulation evidence; outbox payload/topic changes cause restoration conflicts. R6-12’s timestamp qualification matches the implementation.
- **R7-3/4/5/6/9/10:** Reset limiting/admission, atomic workspace capacity, control/workspace RLS, nested masking and record-ID filtering are implemented. Reviewed internal maintenance paths use wildcard scope where needed.
- The retry body reruns transaction checks and rolls back attempted receipt writes before retrying. No double recording inside the retry loop was found; the finalization races above occur outside it.

Passed: three offline network tests and focused scoring/masking/count checks. PostgreSQL, integration, load and deployment checks were not run; database scenarios above are source-traced.
