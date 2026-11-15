# Failure tests

A simulation gate is only worth something if it holds when the simulation is **wrong**. These tests make reality differ from the prediction after approval, without any test hook that weakens a check, and assert that nothing unapproved commits.

Run them: `npm run db:up && TEST_DATABASE_URL=postgres://app:app@127.0.0.1:55432/sim_test npm test`.

## Under-prediction: reality does more than the simulation saw

### 1. A dependency created after the simulation

`test/execute.test.ts`: `FAILURE TEST: a dependency created after the simulation is caught by the verifier and rolled back`.

1. Plan and narrow a customer purge; simulate; approve.
2. Drift `new_order`: a business write gives one target customer a new order, with a line and an invoice. The customer row itself is not touched.
3. Execute.

Expected and asserted:

- `row versions` **passes**. The customer row did not change, so the cheap pre-check cannot see the new child.
- The cascade now deletes 3 rows the simulation never measured. `effects match approval` fails, with `unexpected` = `invoices`, `order_lines`, `orders`, including the drift's order id.
- Status `rolled_back`. `state_restored` is true. Every touched row re-reads intact. The state digest equals the one taken before the attempt. All target customers still exist.
- Recovery: simulating again on current data blocks, the agent excludes that customer, and the new plan commits.

### 2. A configuration change enables a trigger path

`test/execute.test.ts`: `FAILURE TEST: a configuration change makes a trigger write rows the simulation never saw; the verifier rolls back`.

Drift `ledger_mirroring` flips a business setting. A trigger that existed at simulation time now books a ledger entry for every deleted payment. No schema changed and no target row changed, so `row versions` and `schema unchanged` both pass. The verifier sees unexpected `ledger_entries` INSERTs, rolls back, and the digest is unchanged with 0 ledger rows.

### 3. Schema drift, with the schema check disabled

`schema drift: a trigger added after the simulation is refused; with that check disabled the verifier still catches it`. A new trigger is refused by the fingerprint. With that one check disabled by a test hook, the verifier still rolls back the extra writes. That shows the layers are independent. Further tests change a column default and a function without the `snd_` prefix; both are refused.

### 4. Coverage gaps

A business table without the capture trigger, a new table a cascade can reach but the journal does not cover, and a trigger on a bookkeeping table each **stop the simulation** before anything is measured. A gap in measurement is never shown as "no effect".

## Staleness: the data changed

- A target row updated after the simulation: `refused` before anything runs (`row versions`).
- A row deleted and re-inserted with identical content: still `refused`, because its `xmin` differs.
- The dispatcher sends a queued message between a restore's simulation and its execution: the restore is `refused`.

## Infrastructure failures

| Failure | Test | Asserted outcome |
|---|---|---|
| Connection destroyed before COMMIT | `a lost connection during COMMIT is resolved from the durable receipt, not assumed` | `rolled_back`, from the absence of a durable receipt |
| COMMIT succeeded, the acknowledgement was lost (`ECONNRESET`) | `an acknowledgement lost after the server committed is resolved as committed` | `committed`, deletion applied once, approval `consumed`, replay refused |
| Process killed mid-execution | `an execution interrupted by process death is reconciled at start-up` | stuck approval reconciled |
| Reconciliation meets a live execution in another process | `start-up reconciliation waits for a live execution …` | one receipt, the true `committed` one |
| Reconciliation resolves a claim before its transaction starts | `a claim resolved by another process before the transaction began is not executed` | nothing deleted, exactly one `rolled_back` receipt |
| Server saturated | `a busy server refuses execution without consuming the approval` | 503; the approval stays `approved` and later commits |

## At scale: the eval

`npm run eval` runs 40 seeded scenarios with random scopes, exclusions and drift, against real PostgreSQL ([evidence/eval.json](evidence/eval.json)):

| | |
|---|---|
| Drift injected after approval | 25 (10 `reopen_case`, 6 `new_order`, 9 `ledger_mirroring`) |
| Caught before commit | 25: 10 refused on row versions, 15 rolled back by the verifier |
| False-safe commits under drift | 0 |
| Rollbacks or refusals with state re-verified identical | 25; `rollback_left_changes` 0 |
| Side effects escaping a simulation | 0 |

## What these tests do not cover

- A writer that bypasses this service's triggers (for example a superuser with `session_replication_role = replica`) outside the execution transaction, on rows the simulation did not read.
- Effects outside this database: provider-side state, backups, analytics copies. Every report lists them as unknown.
- A COMMIT still in flight in another backend when reconciliation starts. The code waits for it on the shared execution lock, but no test reproduces that timing.
