# Effect measurement

Code: [src/effects.ts](../src/effects.ts), capture trigger in [src/schema.ts](../src/schema.ts).

## The journal

Every business table has an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW` trigger named `zzz_capture`. The name sorts last, so it runs after the domain triggers on the same table. When the transaction-local setting `snd.capture` is set, it appends one row to `change_log`:

```
(capture_id, seq, workspace_id, tbl, op, old_row jsonb, new_row jsonb)
```

`seq` comes from a transaction-local counter, so the journal is totally ordered in the order PostgreSQL made the changes. Ordinary business traffic runs without `snd.capture` and writes nothing.

The journal sees cascades, `SET NULL` actions, rows written by other triggers, and rows written by deferred constraint triggers, because all of them are row-level changes in the same transaction. It does not see `TRUNCATE` (forbidden by trigger) or changes outside this database (listed as unknown).

## Coverage, checked on every simulation and execution

`schemaFingerprint` walks every table in the schema, not just the known list, and reports a gap (which blocks) when:

- a business table has no capture trigger (`addresses (no capture trigger)`);
- a table outside the journalled set is reachable by a foreign key from one that is (`loyalty_cards (not journalled, but reachable by foreign key)`), because a cascade into it would go unseen;
- a bookkeeping table (`executions`, `approvals` …) has a trigger, which could write business rows from outside the journal.

The fingerprint itself covers tables, columns **with their defaults**, constraints, triggers with their enabled state, RLS and policies (qualifier and check), and the source of every non-extension function in the schema. A change to any of them between simulation and execution refuses the execution.

## From journal to effects

`effectsFrom(journal, direct)` produces one effect per journal row:

| Field | |
|---|---|
| `key` | `tbl:id:OP#n`. `n` counts repeated changes to the same row with the same op, so a row updated twice yields two effects. |
| `tbl`, `id`, `op`, `seq` | |
| `before`, `after` | Row images without `workspace_id` and without the clock-derived columns listed in `VOLATILE` in schema.ts (such as `updated_at`, set by `snd_touch`). This is the only tolerance in the whole comparison. |
| `changed` | For updates, the columns whose stable value changed |
| `cause` | See below |

Causes are inferred from the template's declared `direct` set and the FK and trigger topology, never from what the agent said:

| Cause | Rule |
|---|---|
| `direct` | The row is in the template's direct set: the table, operation and frozen target ids the template mutates. |
| `cascade` | A DELETE not in the direct set: removed by `ON DELETE CASCADE`. |
| `set_null` | An UPDATE in which every changed column became null. That is the signature of `ON DELETE SET NULL`, as on `support_cases.customer_id` and `customers.referred_by`. |
| `trigger` | Any other row, written by a domain trigger: outbox messages, ledger reversals, `updated_at` touches with content changes. |
| `restore` | For a restoration (`direct.explicit`), every non-outbox row it writes. A restoration is deliberate in all of its rows. |

## Digest and comparison

`effectDigest(effects)` is a SHA-256 over the sorted list of per-effect fingerprints. Each fingerprint is the canonical JSON (sorted keys) of the effect's key, its stable before image and its stable after image. The digest does not depend on order. The approval binds this digest. At execution, `compare(approved, actual)` returns:

- `unexpected`: keys in actual, not approved
- `missing`: keys approved, not in actual
- `changed`: same key, different images

`match` requires all three to be empty. A difference in any column of any row of any table is a mismatch.

## Correctness evidence

- Test `measured effects equal an independent SQL oracle, table by table`. For the purge, hand-written SQL joins count the rows the FK graph and triggers should touch: orders of the targets, their lines, invoices, payments and shipments, subscriptions, addresses, support cases that would be orphaned, customers they referred, and the outbox messages expected from active subscriptions, open shipments and open cases. The test asserts that the measured count equals the oracle count per table and operation, and that causes include direct, cascade, set_null and trigger. The oracle shares no code with the capture path. It checks counts, not row identities.
- Test `the same action yields identical effects in two simulations` (determinism).
- Scoring (`score` in `scripts/eval.ts`) compares each effect by its key **and** its stable before and after images. A prediction with the right row but the wrong values counts as both a false positive and a false negative; it is tested.
- The property test (`test/property.test.ts`) and the eval: across random scopes, the effect set on every commit equals the approved effect set (605/605). This equality is enforced by the verifier, so it shows the system behaves as designed, not that prediction is clever.

## Masking

Effects returned over HTTP pass through `maskRow`: e-mail addresses become `xx***@domain`, and `workspace_id` is removed. The stored effects, used for digest and comparison, are unmasked; they never leave the server unmasked.
