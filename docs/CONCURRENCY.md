# Concurrency

Everything between simulation and commit is a race window. This document lists each race, what wins it, and the test that proves it.

| Race | Mechanism | Outcome | Test |
|---|---|---|---|
| Two executions of one approval (double click, two tabs, replay) | Atomic claim `UPDATE … SET status='executing' WHERE status='approved' … RETURNING` | Exactly one runs. The other gets 409 "approvals are single-use". | `two simultaneous executions of one approval: exactly one runs`; eval: 40 concurrent duplicates refused, 0 double executions |
| Replay after completion | Approval ends as `consumed` or `failed`, never `approved` | 409 | eval: 40 replays refused |
| Two approvals of one simulation | Partial unique index `approvals_one_live (simulation_id) WHERE status IN ('approved','executing','consumed')` | Second one 409 `already-approved` | `two approvals of one simulation, wrong token, …` |
| Two executions in one workspace | `pg_advisory_xact_lock(hashtext('exec:'‖ws))` | Serialised | – |
| A target row changes after the simulation | Row versions (`xmin`) bound at simulation and re-read under `FOR UPDATE` | `refused`: "Records changed after the simulation" | `a record updated after the simulation makes the approval stale before anything runs`; eval `reopen_case` 10/10 |
| A row is deleted and re-inserted with identical content | `xmin` differs even though content matches | `refused` | `a row deleted and re-inserted with the same key and content is still detected` |
| A dependent row is created after the simulation (new order for a target) | The verifier compares actual effects with the approved ones | `rolled_back`: 3 unexpected effects | `FAILURE TEST: a dependency created after the simulation …`; eval `new_order` 6/6 |
| A configuration change enables a trigger path (ledger mirroring) | Same | `rolled_back` | `FAILURE TEST: a configuration change makes a trigger write rows …`; eval `ledger_mirroring` 9/9 |
| Schema changes after the simulation | Schema fingerprint re-checked in the execution tx | `refused`. With that check disabled by a test hook, the verifier still rolls back. | `schema drift: a trigger added after the simulation is refused; …` |
| A business write races the execution on the same rows | `FOR UPDATE` on targets; SERIALIZABLE | The writer waits on the lock, then fails its FK or serialisation check. No orphan. | `a business write racing the execution waits on the row lock, then fails: no orphan is created` |
| The dispatcher sends a message between restore simulation and execution | Restore binds versions of every row it will touch, outbox included | Restore `refused` (stale) | `the dispatcher moving a message between restore simulation and execution makes the restore stale` |
| The dispatcher sees a simulation's queued messages | The dispatcher reads only committed rows (`FOR UPDATE SKIP LOCKED`), and a simulation never commits | Never dispatched. `deliveries_before == deliveries_after` in every proof. | `a simulation leaves no durable effect` |
| Serialization failure during simulation | Retry up to 3 times (safe: a simulation is rollback-only) | 503 after 3 attempts, nothing changed | – |
| Serialization failure or deadlock during execution | Retried from the top of the transaction, every in-transaction check run again, up to 5 attempts with jittered backoff. Executions in *different* workspaces can trip SERIALIZABLE's conservative conflict detection; the retry absorbs it | Committed after retry; `rolled_back` receipt with state proof after 5 | `a busy server refuses execution without consuming the approval` (3 parked executions in 3 workspaces all commit) |
| Lock or statement timeout during execution | Transaction rolled back by PostgreSQL | `rolled_back` receipt with state proof | – |
| An edit or rejection races the execution of the same action | Edit, reject and execution all take the action row `FOR UPDATE`; execution re-reads the action status in its transaction | The edit waits, then gets 409 "no longer open". No replacement action is created | `an edit racing an execution waits for it, then finds the action executed` |
| A newer simulation of an approved action | Simulating revokes live approvals of older simulations; execution also requires its simulation to be the latest | The older approval is `rejected` | `a newer simulation of the same action revokes the older approval` |
| The stored evidence is swapped under an intact signature | The binding is rebuilt from the stored simulation and action and compared with the signed one | `refused` (approval binding) | `evidence swapped in storage under an intact signature is refused` |
| Connection lost during or after COMMIT | `CommitUnknown`: a new transaction waits on the same `exec:<workspace>` lock, then looks for this attempt's receipt or any receipt for the approval | The true receipt; otherwise `rolled_back`. `503 outcome-unknown` if the lock is not free in 30 s | `a lost connection during COMMIT …`; `an acknowledgement lost after the server committed is resolved as committed` |
| Process killed during execution | `recoverInterrupted` at start-up, per stuck approval under the `exec:<workspace>` lock and the approval row lock | Reconciled to `consumed` if a receipt exists, else a `rolled_back` receipt. A live execution in another process is waited for, not overwritten | `an execution interrupted by process death …`; `start-up reconciliation waits for a live execution …` |
| Reconciliation resolves a claim before its transaction starts | The execution re-reads the approval `FOR UPDATE` in its transaction and requires `executing` | 409 "resolved by another process"; exactly one receipt | `a claim resolved by another process before the transaction began is not executed` |
| Many visitors at once | 3 concurrent heavy operations per process, then 503 **before** the approval is claimed; per-IP buckets with a capped table | Pool cannot be starved; a refused visitor keeps a usable approval | `rate limits: …`; `the memory cap never renews a budget` |
| Concurrent session creation at capacity | Workspace creation counts and inserts under one advisory lock | Never more than the cap | `workspace capacity holds under concurrent session creation` |

## Isolation levels

- **Simulation: REPEATABLE READ.** The predicate, the dry run and the bound row versions all read one snapshot.
- **Execution: SERIALIZABLE**, plus explicit row locks. The locks make concurrent writers wait instead of interleaving. SERIALIZABLE turns any remaining anomaly into a rollback, not a silent commit.
- **Ordinary business traffic and drift: READ COMMITTED**, without capture.

## What is deliberately not handled

A writer that bypasses this service and its triggers (for example a superuser with `session_replication_role = replica`) is invisible to the journal. Check 7 (independent row counts) catches row-count changes it causes inside the execution transaction. Changes outside the transaction are caught by the row versions only for rows the simulation read. Every report lists this as unknown.
