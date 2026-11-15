# Execution and verification

Code: `Engine.#execute` in [src/engine.ts](../src/engine.ts).

Execution runs the same template `apply` the simulation ran, inside a SERIALIZABLE transaction. Before COMMIT, it checks that what actually happened equals what was approved. Any difference rolls the transaction back, so nothing unapproved ever commits.

## Order of checks

| # | Check | Where | Catches | On failure |
|---|---|---|---|---|
| – | admission (at most 3 heavy operations per process) | before the claim | an overloaded server | `503 busy`; the approval stays `approved` and usable |
| – | claim: `approved → executing`, nonce hash compared, not expired | before the tx | replay, a wrong token, an expired approval | `409`; nothing recorded |
| 1 | **approval binding** | before the tx | the binding is **rebuilt from the stored records** (effect digest recomputed from the stored effects, spec hash recomputed from the action, expiry, nonce hash) and compared canonically with the signed one; HMAC checked | `refused` |
| – | `pg_advisory_xact_lock(exec:<workspace>)` | tx | one execution per workspace at a time | waits |
| – | approval `FOR UPDATE`, still `executing` | tx | another process (start-up reconciliation) resolved this claim between the claim and the transaction | `409 approval-unusable`; its receipt stands |
| 2 | **action still open** | tx, action `FOR UPDATE` | action edited, rejected, replaced or executed; or a newer simulation of it exists. Edits and rejections take the same row lock, so they wait for the execution and then find the action executed | `refused` |
| 3 | **capture coverage** | tx | a business table without the journal trigger | `refused` |
| 4 | **schema unchanged** | tx | tables, columns, constraints, triggers or functions changed since the simulation (fingerprint) | `refused` |
| – | `SELECT … FOR UPDATE` on target rows (and, for a restore, every row it will update or delete) | tx | concurrent writers now wait on the lock | waits |
| 5 | **row versions** | tx | any row the simulation read changed since (by `xmin`), including delete and re-insert with identical content | `refused` |
| – | `apply()`, then `SET CONSTRAINTS ALL IMMEDIATE` | tx | | |
| 6 | **effects match approval** | tx | any unexpected, missing or different effect: a trigger enabled by configuration, a dependent row created after the simulation, changed images | `rolled_back` |
| 7 | **independent row counts** | tx | for each table, the change in row count (before vs after `stateDigest`) must equal journal inserts minus deletes. This catches a write the journal did not see. | `rolled_back` |
| 8 | **policy on actual effects** | tx | the policy evaluated again over the *actual* effects, not the approved ones | `rolled_back` |
| – | write receipt and recovery record, consume approval, COMMIT | tx | | |

Checks 1–5 are **refusals**: they run before anything is mutated. Checks 6–8 are **verifier** checks. They run after the mutation and before COMMIT, and their failure throws, which rolls back the transaction.

Why check 7 as well as check 6? Check 6 compares the journal with the approval. Check 7 compares the journal with the database, using a separate measurement (per-table row counts in `stateDigest`). If the journal were incomplete, for example because a capture trigger was bypassed, check 6 could pass while check 7 fails.

## The receipt

**Committed** receipts contain: every check with its detail, `pre_state` and `post_state` digests, the effect summary, the effect count, the approved digest, the operator, the isolation level and timing. The journal is moved from `change_log` into `executions.recovery`, which is the recovery record, available for 24 h.

**Refused or rolled-back** receipts (`#failed`) contain, in addition:

- `reason` and `next` ("Simulate again against the current data; a new approval is required");
- `state_restored`: the pre-state digest compared with a digest taken **from a new transaction** after the rollback;
- `intact`: every row the attempt touched, re-read. For updated or deleted rows the stable image must equal the before image. Inserted rows must not exist. The UI shows "137 of 137 touched rows re-read intact";
- `journal_residue`: capture rows left for this execution id, always 0;
- `comparison`: unexpected, missing and changed effects (capped for size) with counts;
- `policy` over the actual effects.

The incident dialog in the UI is drawn from this receipt.

## Failure classes

| Condition | Result |
|---|---|
| Verifier mismatch | `rolled_back`, with the proof above |
| Serialization failure or deadlock | retried from the start of the transaction, with all in-transaction checks run again, up to 5 attempts with jittered backoff. SERIALIZABLE can report false conflicts between executions in different workspaces; the retry absorbs them. After 5 attempts: `rolled_back` |
| Lock or statement timeout | `rolled_back` ("PostgreSQL rolled the transaction back") |
| Unique or FK violation during apply | `rolled_back` |
| Connection lost **during or after COMMIT** (any non-PostgreSQL error once COMMIT was sent) | the outcome is read from the database, never assumed. A new transaction first takes the same `exec:<workspace>` lock (up to 30 s), so it cannot read before a still-running commit finishes; if that times out the client gets `503 outcome-unknown`. Then: this attempt's receipt exists → committed; another receipt for the approval exists → that one; neither → `rolled_back`. `executions.approval_id` is unique, so one approval never has two receipts |
| Process killed mid-execution | at start-up `recoverInterrupted` finds approvals stuck in `executing`. For each, it takes the `exec:<workspace>` lock and the approval row lock, so it waits for an execution that is still live in another process, then rechecks the status. A committed receipt reconciles it to `consumed`; without one, it writes a `rolled_back` receipt |
| Anything else | approval `failed`, error surfaced as 500 with "Nothing was executed unless a receipt says so" |

Tests are in [FAILURE-TEST](FAILURE-TEST.md) and [CONCURRENCY](CONCURRENCY.md).

## Test hooks

`Engine.hooks` (`skipSchemaCheck`, `skipVersionCheck`, `beforeCommit`, `afterCommit`, `afterClaim`) exist only to prove that the later checks catch what an earlier check would have refused, for example that the verifier still catches a trigger added after the simulation when the schema check is disabled. They are plain properties on the engine object. No HTTP route, environment variable or request field can set them.
