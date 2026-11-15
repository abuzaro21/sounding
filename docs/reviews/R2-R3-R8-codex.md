# Codex review: R2 simulation engine, R3 effect measurement, R8 eval honesty

| | |
|---|---|
| Reviewer | Codex CLI, model `gpt-6.1-sol` (from the run's own header), provider openai |
| Mode | `sandbox: read-only`, `approval: never`, reasoning effort high |
| Session | `01a1e08b-745a-7e91-aaa3-15aaa170bbd8` |
| Reviewed | commit `42faa18` |
| Prompt | [R2-R3-R8-codex.prompt.md](R2-R3-R8-codex.prompt.md) |

**Every fix below was made after this review, in commit `60b23b7`, and was not reviewed by Codex in this pass.** The final diff review (R9) covers them.

## Triage

Each finding was checked against the code before it was fixed.

| Finding | Claim | Verdict | Change | Test |
|---|---|---|---|---|
| 1 High | FK-reachable tables outside the journalled set | Confirmed. Fixed | The fingerprint walks every table in the schema; an FK-reachable unjournalled table blocks | `a table outside the journalled set that a cascade reaches, or a trigger on a bookkeeping table, stops the simulation` |
| 2 High | Fingerprint omits column defaults | Confirmed. Fixed | Defaults (`pg_get_expr(adbin)`) are in the fingerprint | `schema drift: a changed column default is refused …` |
| 3 Medium | Several lines of one product release one reservation | Confirmed. Fixed | `snd_order_cancelled` aggregates quantities per product | `cancelling stale orders: …` asserts the release per product |
| 4 Medium | Eval scores keys only; fp/fn reversed | Confirmed. Fixed | `score()` compares key and stable before/after images; predicted-not-actual = fp | `scoring: a same-key effect with a different image is a miss on both sides` |
| 5 Medium | `blocking_rows_prevented` counts rule matches | Confirmed. Fixed | Counts distinct `tbl:id` per proposal: 935 became 866 | eval re-run; README updated |
| 6 Medium | Lost-acknowledgement case untested | Confirmed. Fixed | `afterCommit` hook; transport errors after COMMIT go to reconciliation | `an acknowledgement lost after the server committed is resolved as committed` |
| 7 Low | `restore` cause count is NaN | Confirmed (found independently before reading the review). Fixed | `restore: 0` initialised | `a committed deletion is restored exactly …` asserts the count |

## Codex output, verbatim

Local absolute paths in links were made repository-relative; nothing else was changed. The full run log is kept locally and not published, because it contains local paths.

Reviewed `42faa18c3463977389e33b43e0c6b6e924ca5498`. Seven findings; the first two require a schema change.

1. **High — `src/db.ts:89`: Capture coverage and schema fingerprinting silently exclude newly added dependent tables.**  
   **Scenario:** A migration adds a table with an `ON DELETE CASCADE` FK to `customers`, without adding it to `TABLES`. Its table, FK and missing capture trigger are excluded from the fingerprint. Deleting a customer then deletes those dependent rows without including them in simulation evidence; execution’s journal comparison and independent counts also exclude them and can commit.  
   **Smallest fix:** Discover FK-reachable tables from the catalog and refuse simulation/execution when any fall outside the reviewed, captured table set. Add a regression with an unlisted cascading child.

2. **High — `src/db.ts:94`: The fingerprint omits column defaults, allowing an undetected change to outbox delivery timing.**  
   **Scenario:** After approval, change `outbox.created_at`’s default from `now()` to a timestamp in 2000. The fingerprint remains unchanged. `snd_emit()` uses that default (`src/schema.ts:183`), while effect normalization removes `created_at` (`src/schema.ts:14`). Execution therefore accepts the changed effects, and `dispatch()` immediately considers the messages eligible instead of holding them for 60 seconds (`src/engine.ts:494`).  
   **Smallest fix:** Include column default expressions in the schema fingerprint and test that changing this default invalidates approval.

3. **Medium — `src/schema.ts:256`: Cancellation releases only one matching order line’s reservation when multiple lines reference the same product.**  
   **Scenario:** Seed 1 contains cancellable order `ord_0251` with two `prd_09` lines, quantities 1 and 2. PostgreSQL’s `UPDATE … FROM` updates the product once using one matching line, so it releases 1 or 2 units instead of 3. Simulation and execution can agree on—and commit—the same incorrect inventory result. Neither journal equality nor row counts checks the reservation invariant.  
   **Smallest fix:** Aggregate quantities by product before updating `reserved`; add a cancellation regression asserting the full quantity is released.

4. **Medium — `scripts/eval.ts:66`: Effect accuracy compares only keys, and its precision/recall denominators are reversed.**  
   **Scenario:** Predicted and committed effects have identical table/ID/operation keys but different refund amounts, payloads or inventory values. Every effect still counts as a true positive and both scores remain 1. Separately, predicted-only effects increment `fn`, while actual-only effects increment `fp`, reversing conventional prediction precision and recall. `test/property.test.ts:10` consequently cannot establish its claimed exact prediction from these scores.  
   **Smallest fix:** Match keys plus normalized before/after images, correct the false-positive/false-negative accounting, and add a same-key/different-value evaluation regression.

5. **Medium — `scripts/eval.ts:45`: `blocking_rows_prevented` counts rule matches rather than distinct rows.**  
   **Scenario:** One recent unpaid invoice triggers both `OPEN_OBLIGATION` and `FINANCIAL_RETENTION` (`src/policy.ts:93`, `src/policy.ts:102`), increasing the reported prevented-row count by two. An in-memory check confirmed this duplication. The published total therefore overstates distinct blocked records.  
   **Smallest fix:** Deduplicate by table and ID within each proposal, or rename the metric to describe blocking rule matches.

6. **Medium — `test/execute.test.ts:190`: The ambiguous-COMMIT test destroys the connection before COMMIT is submitted, leaving the committed-but-acknowledgement-lost case untested.**  
   **Scenario:** `Db.tx()` calls `beforeCommit` before issuing `commit` (`src/db.ts:47`). This test therefore forces the rollback outcome, then checks only that outcome; it does not exercise reconciliation when PostgreSQL committed successfully but the application received a connection error.  
   **Smallest fix:** Add a fault test that completes the database COMMIT and then substitutes a connection error, asserting that receipt reconciliation returns the committed execution without another mutation.

7. **Low — `src/effects.ts:77`: Restoration cause counts become `NaN`, serialized as `null`, because `restore` is absent from the initialized counters.**  
   **Scenario:** Restoring an address produces `cause: 'restore'`; incrementing the missing counter yields `NaN`. The resulting report contains `"restore": null` instead of the number of restored effects. Confirmed with an in-memory check.  
   **Smallest fix:** Initialize `restore: 0` and assert its count for a restoration effect.

### Verified sound

- **Shared mutation:** Both paths invoke the same runner/template `apply()` (`src/engine.ts:217`, `src/engine.ts:355`). Their surrounding checks differ: simulation uses repeatable read, predicate resolution and savepoint rollback; execution uses serializable isolation, locks, effect comparison and independent counts.
- **Capture timing:** Transaction-local capture context is established before application work (`src/db.ts:41`). Every listed business table receives row capture and a rejecting `TRUNCATE` trigger (`src/schema.ts:285`).
- **Indirect/deferred writes:** Both paths flush deferred constraints before reading the journal (`src/engine.ts:218`, `src/engine.ts:356`). Existing trigger-generated DML targets captured business tables; subsequent trigger writes invoke those tables’ capture triggers.
- **Rollback boundary:** Existing mutation functions contain no sequence operations, remote calls or session advisory locks. Settings, outbox and journal writes are transactional. Simulation evidence and audit bookkeeping deliberately persist afterward. The `unchanged` digest covers `TABLES`; delivery counts are recorded separately.
- **Comparison mechanics:** Canonical object-key ordering and distinct occurrence keys preserve repeated changes to one row. In-memory checks confirmed that removing a repeated effect causes comparison failure.
- **Under-prediction tests:** The new-order and ledger-mirroring tests change real stored state without bypass hooks (`test/execute.test.ts:78`, `test/execute.test.ts:105`). Their asserted version/schema checks pass before effect comparison rejects the additional writes.

Not run: PostgreSQL, integration tests or eval; no network/database access or file changes. Schema-change scenarios were verified from source, not reproduced against PostgreSQL.
