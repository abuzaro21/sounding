# Simulation engine

The dry run is the real mutation, executed by PostgreSQL in a transaction that always rolls back. No model of the schema, no query planner estimate, no parsed SQL. Whatever cascades, triggers, `SET NULL` actions and deferred constraints the database would run, it runs, and the capture journal records them.

Code: `Engine.simulate` in [src/engine.ts](../src/engine.ts), `Db.tx` in [src/db.ts](../src/db.ts).

## Sequence

```
outside(before):  state digest of every business table, count(deliveries)       ← separate tx
BEGIN ISOLATION LEVEL REPEATABLE READ;  set_config(snd.ws, snd.capture = sim id, timeouts)
  schemaFingerprint()          refuse if any business table lacks the capture trigger
  pre       = stateDigest()
  predicate = template.resolve()           what the selection matches *now* (for TARGET_DRIFT)
  SAVEPOINT dry_run
    template.apply()                       the same function execution calls
    SET CONSTRAINTS ALL IMMEDIATE          deferred constraint triggers fire inside the measurement
    journal = change_log where capture_id = sim id
  ROLLBACK TO SAVEPOINT dry_run
  residue   = count(change_log where capture_id = sim id)   must be 0
  versions  = xmin of every row the journal names            same snapshot as the dry run
  inTxAfter = stateDigest()
ROLLBACK                                    rollbackOnly: the transaction never commits
outside(after):   state digest, count(deliveries)                                ← separate tx
effects = effectsFrom(journal, direct)
policy  = evaluate(effects, …)
INSERT simulations (effects, effect_digest, row_versions, schema_fp, report, verdict, durable)
```

## The durability proof

Every simulation report carries `durable`:

| Field | Meaning |
|---|---|
| `journal_rows_in_dry_run` | Row changes the dry run made |
| `journal_residue_after_rollback` | Journal rows left after the savepoint rollback. Always 0. |
| `state_before`, `state_after` | Digest of every business table, read in separate transactions before and after |
| `unchanged` | `state_before == state_after` **and** the in-transaction pre and post digests are equal |
| `deliveries_before`, `deliveries_after` | Nothing reached a provider |

The state digest is `md5` over `to_jsonb` of every row, ordered, per table, plus row counts (`stateDigest`). Test `a simulation leaves no durable effect` asserts all of it, and `live-check.ts` asserts it against the deployment.

## Why these choices

- **REPEATABLE READ.** The predicate, the dry run and the row versions all come from one snapshot, so the bound versions describe exactly the data the simulation saw.
- **Savepoint, then a whole-transaction rollback.** The savepoint lets the engine read the residue and the versions after the mutation is undone. The outer `rollbackOnly` guarantees nothing commits even if the code after the savepoint threw.
- **`SET CONSTRAINTS ALL IMMEDIATE`.** The `order_lines → products` FK is `DEFERRABLE INITIALLY DEFERRED`. Without this step, its checks and any deferred constraint trigger would run at COMMIT, which a dry run never reaches. Test `deferred constraint triggers fire inside the measurement` covers it.
- **Deterministic trigger ids.** Rows that triggers create (outbox, ledger entries) get ids from `snd_id(prefix, parts)`, a hash of their content. Two simulations of one action, and the execution, therefore produce identical effect keys. Test `the same action yields identical effects in two simulations`.
- **Capture coverage is checked, not assumed.** `schemaFingerprint` lists every business table without the `zzz_capture` trigger, and simulation refuses to run. Test `simulation refuses to run if any business table is not journalled`.
- **`TRUNCATE` is forbidden** on business tables by a statement trigger, because row triggers do not see it.
- **Serialization failures** (`40001`) are retried up to 3 times, since a simulation is safe to repeat. Other transient errors abort with "Nothing was changed".
- **Concurrency cap.** At most 3 simulations or executions hold a connection at once; the rest get 503.

## What a simulation knows and what it does not

The report separates three kinds of knowledge.

1. **Measured**: every row change in this database, with before and after images.
2. **Modeled**: what each provider will do with the messages the dry run queued, from the shop's documented contracts (`MODELED` in engine.ts). Labeled as modeled in the UI.
3. **Unknown**: listed in every report: copies outside the database (backups, replicas, WAL, analytics exports), what providers actually do after receiving a message, and writes by systems that bypass this service and its triggers.

## Freshness

A simulation can be approved only if it is the latest one for its action, is younger than 10 minutes, and passed policy. Execution later checks the bound row versions and schema fingerprint again (see [EXECUTION-VERIFICATION](EXECUTION-VERIFICATION.md)).
