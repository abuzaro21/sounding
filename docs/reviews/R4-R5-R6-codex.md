# Codex review: R4 approvals, R5 execution and verification, R6 rollback and concurrency

| | |
|---|---|
| Reviewer | Codex CLI, model `gpt-6.1-sol` (from the run's own header), provider openai |
| Mode | `sandbox: read-only`, `approval: never`, reasoning effort high |
| Session | `01a1e08b-74a4-7333-b51c-306483417381` |
| Reviewed | commit `42faa18` |
| Prompt | [R4-R5-R6-codex.prompt.md](R4-R5-R6-codex.prompt.md) |

**Every fix below was made after this review, in commit `60b23b7`, and was not reviewed by Codex in this pass.** The final diff review (R9) covers them.

## Triage

Each finding was checked against the code before it was fixed.

| Finding | Claim | Verdict | Change | Test |
|---|---|---|---|---|
| 1 High | Rejected or superseded action can still execute | Confirmed. Fixed | Execution locks the action `FOR UPDATE` and re-checks it in its transaction; edit and reject take the same lock and refuse a closed action | `an edit racing an execution waits for it, then finds the action executed` |
| 2 High | Start-up recovery can record a false rollback for a live worker | Confirmed. Fixed | Reconciliation runs under the `exec:<ws>` lock and the approval row lock; execution requires `executing` in its transaction; `executions.approval_id` unique | `start-up reconciliation waits for a live execution …`; `a claim resolved by another process before the transaction began is not executed` |
| 3 High | Control-plane triggers and non-`snd_` functions escape the fingerprint | Confirmed. Fixed | A trigger on a bookkeeping table blocks; every non-extension function in the schema is fingerprinted | `a table outside the journalled set … or a trigger on a bookkeeping table …`; `… and so is a changed function without the snd_ prefix` |
| 4 Medium | Binding not rebuilt from the records actually used | Confirmed. Fixed | The binding is rebuilt from stored records with digests recomputed and compared canonically | `evidence swapped in storage under an intact signature is refused` |
| 5 Medium | Busy rejection leaves the approval `executing` | Confirmed. Fixed | Admission before the claim | `a busy server refuses execution without consuming the approval` |
| 6 Medium | Older approval executable after a newer simulation | Confirmed. Fixed | A new simulation revokes older approvals; execution requires the latest simulation | `a newer simulation of the same action revokes the older approval` |
| 7 Medium | One absent receipt lookup does not resolve an uncertain COMMIT | Confirmed. Fixed | Reconciliation first takes the `exec:<ws>` lock (30 s, else 503 `outcome-unknown`), then looks for its own or any receipt for the approval | Partly: the lost-ack test covers the committed path; the wait on a commit still in flight is not reproduced by timing |
| 8 Medium | Transport errors with a `code` bypass `CommitUnknown` | Confirmed. Fixed | Only `pg.DatabaseError` is treated as a definite outcome | `an acknowledgement lost after the server committed …` (ECONNRESET) |
| 9 Medium | Referral cycles cannot be restored | Confirmed. Fixed | One `jsonb_populate_recordset` insert per table | `customers that referred one another in a cycle are restored together` |
| 10 Medium | Expiry leaves simulation before-images | Confirmed. Fixed | No workspace outlives the 24 h recovery window; the purge deletes it with everything it holds | `recovery records expire …` asserts executions, simulations, customers and audit are gone |
| 11 Medium | Restoration skips outbox content conflicts | Confirmed. Fixed | Message content except status must equal the original image | `a queued message changed after the original action blocks its restoration` |
| 12 Low | "Restored exactly" excludes `updated_at` | Confirmed. Claim narrowed | Kept the stamp (it records the restoration); docs and test now say so | `a committed deletion is restored exactly …` asserts `updated_at` is the restore time |

## Codex output, verbatim

Local absolute paths in links were made repository-relative; nothing else was changed. The full run log is kept locally and not published, because it contains local paths.

Reviewed `42faa18`; concurrent working-tree changes are excluded.

1. **High — `src/engine.ts:338`, `src/engine.ts:375`: Execution can commit an action that was rejected or superseded after its status was read.**  
   Scenario: execution claims the approval and reads `proposed`; edit/reject completes; execution then starts its transaction. Its cached status passes, and the unconditional final update overwrites `superseded`/`rejected` with `executed`. Approval invalidation excludes `executing` approvals.  
   **Smallest fix:** lock and recheck the action inside execution’s transaction; make edit, revision, and rejection coordinate through that same lock and reject terminal actions. The existing edit test (`test/execute.test.ts:58`) covers only sequential requests.

2. **High — `src/engine.ts:438–447`, `src/schema.ts:163–168`: Startup recovery can record a false rollback for another live worker.**  
   Scenario: during overlapping server instances, worker A claims an approval but has not started its mutation transaction; worker B’s recovery sees `executing` without a receipt, inserts `rolled_back`, and marks it failed. A subsequently executes and commits because it never rechecks approval status. Both receipts survive: executions have no uniqueness constraint on `approval_id`.  
   **Smallest fix:** reconcile under the execution lock, require execution to revalidate its claim under that lock, and enforce one terminal receipt per approval.

3. **High — `src/db.ts:88–101`, `src/engine.ts:367–375`: Control-plane triggers can cause unapproved domain writes after verification without invalidating the schema fingerprint.**  
   Scenario: after simulation, a migration adds an `AFTER INSERT` trigger on `executions`, calling a function without the `snd_` prefix that inserts a ledger entry. Neither the trigger nor function changes the fingerprint. Execution passes verification, inserts its receipt, triggers the additional write, deletes its journal, and commits the unapproved effect.  
   **Smallest fix:** reject domain-writing triggers on bookkeeping tables and include those tables’ trigger definitions/functions in manifest validation.

4. **Medium — `src/engine.ts:335–337`: HMAC verification authenticates the stored binding object without fully binding it to the records actually used.**  
   Scenario: stored `simulation_id` pointers can be swapped between otherwise equivalent simulations without comparing the signed simulation identity. More seriously, changing `s.effects` while retaining its stored `effect_digest` makes execution compare against unsigned replacement evidence. This requires stored-record tampering, rather than a browser-only request. Operator, expiry, nonce, schema, and policy fields also lack complete cross-checks.  
   **Smallest fix:** reconstruct the binding from current authoritative records, recompute the spec/effect digests, and verify every identity and security-relevant field.

5. **Medium — `src/engine.ts:315–324`: Capacity rejection leaves a claimed approval permanently `executing` until restart recovery.**  
   Scenario: three simulations occupy `#gate`; execute changes its approval to `executing`, then receives `503 busy` outside any cleanup handler. Every retry fails single-use validation.  
   **Smallest fix:** enter the gate before claiming the approval and protect the complete post-claim lifecycle with cleanup. Confirmed with an in-memory check.

6. **Medium — `src/engine.ts:284–285`, `src/engine.ts:327–353`: A previously approved simulation remains executable after a newer simulation exists.**  
   Scenario: approve S1, simulate the same action again as S2, then execute S1’s approval while domain state remains unchanged. Execution succeeds because “latest” is checked only when approving.  
   **Smallest fix:** recheck the latest simulation during execution under coordinated action locking, or invalidate older approvals when publishing a new simulation.

7. **Medium — `src/engine.ts:384–386`: One absent receipt lookup does not resolve an uncertain COMMIT outcome.**  
   Scenario: the original backend is still finishing COMMIT when the replacement connection sees no receipt. The code assumes rollback and attempts to insert a failure receipt; if the original commits, that insert instead fails on the execution primary key, producing an error rather than the committed result.  
   **Smallest fix:** wait for the original transaction to finish through the shared execution lock, then reread its receipt. `test/execute.test.ts:186–197` destroys the connection before COMMIT and does not test a lost acknowledgement after server-side commit.

8. **Medium — `src/db.ts:49`: Transport errors carrying a `code` bypass `CommitUnknown`.**  
   Scenario: COMMIT loses its connection with `ECONNRESET` after PostgreSQL commits. The code treats that transport code as a definite database failure and skips receipt reconciliation.  
   **Smallest fix:** distinguish definite server abort responses from transport errors; reconcile uncertain transport outcomes. Confirmed using an in-memory client emitting `ECONNRESET`.

9. **Medium — `src/templates.ts:120–125`, `src/schema.ts:51`: Restoration cannot restore valid cycles in customer referrals.**  
   Scenario: customers A and B refer to each other and are deleted together. Neither can be inserted first under the immediate foreign key; the fallback inserts a row whose referenced customer is absent, causing `23503`.  
   **Smallest fix:** restore all deleted customers in one INSERT statement before dependent tables. A single customer referring to itself is supported; multi-row cycles are not. Confirmed with an in-memory constraint check.

10. **Medium — `src/engine.ts:92–93`, `src/engine.ts:250–252`: Recovery expiry does not remove all retained copies of deleted data.**  
    Scenario: an active workspace remains alive beyond recovery expiry. Cleanup clears `executions.recovery`, but simulation effects retain deleted customers’ names, emails, addresses, and other before-images without an expiry path. Cleanup also runs only every 15 minutes (`src/main.ts:23`).  
    **Smallest fix:** expire or redact corresponding simulation evidence and other retained before-images; state the actual cleanup delay. The expiry test checks only the recovery column.

11. **Medium — `src/templates.ts:112–116`: Restoration skips content-conflict checks for outbox rows.**  
    Scenario: a pending message’s aggregate or payload changes after the original execution but before restore simulation. Restoration treats it as compatible and cancels the changed message. For a dispatched row, compensation uses the original payload regardless of the current payload.  
    **Smallest fix:** compare the immutable outbox content with its original image, permitting only documented status/timestamp transitions. Confirmed with an in-memory changed-payload check.

12. **Low — `src/templates.ts:128–131`, `src/schema.ts:207–208`, `test/restore.test.ts:14–19`: The “restored exactly” claim excludes timestamps that restoration actually changes.**  
    Scenario: restoring an updated order or support case supplies its original `updated_at`, but `snd_touch` replaces it with `now()`. The restoration tests remove that column before comparing snapshots, so they cannot establish exact before-image restoration.  
    **Smallest fix:** preserve those timestamps during restoration, or narrow the exactness claim and explicitly test the intended timestamp behavior.

## Verified sound

- The atomic approval claim checks workspace, nonce hash, operator, expiry, and single-use status (`src/engine.ts:315–316`). Concurrent requests using one approval cannot both claim it.
- For the shipped DDL, deferred constraints/triggers are flushed before journal comparison (`src/engine.ts:356–367`); subsequent checks remain immediate.
- Root `FOR UPDATE` locks protect targeted rows, while serialization failures, changed row versions, and changed measured effects prevent commit.
- Domain mutation, committed receipt, recovery journal, approval consumption, and restoration consumption share one transaction (`src/engine.ts:370–376`).
- The dispatcher cannot see newly inserted uncommitted outbox rows. Restore locks existing outbox rows, and dispatch between simulation and execution changes their versions.
- Restoration checks reused IDs, customer email conflicts, and changed supported rows; delivered records remain delivered, with separate compensation messages. Recovery expiry blocks restoration even before cleanup runs.

Not run: database-backed tests or live PostgreSQL concurrency; four checks ran entirely in memory. Risk: backend failure timing remains untested.
