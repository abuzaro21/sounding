# Rollback and recovery

SOUNDING has two different undo mechanisms. Mixing them up is how systems overclaim, so they are documented separately.

## 1. Rollback before commit (exact)

When any verifier check fails ([EXECUTION-VERIFICATION](EXECUTION-VERIFICATION.md)), the execution transaction throws before COMMIT and PostgreSQL rolls it back. This is the database's own atomicity guarantee, so it is exact. SOUNDING still proves it rather than asserting it. From a **new transaction**, the failure path:

- takes the state digest again and compares it with the pre-execution digest (`state_restored`);
- re-reads every row the attempt touched: updated and deleted rows must equal their before image, and inserted rows must not exist (`intact: { checked, intact }`);
- counts capture-journal residue for the execution id (`journal_residue`, which must be 0);
- confirms that no outbox message the attempt queued exists, so nothing can be dispatched.

The incident dialog shows this proof, for example "Rolled back before commit. State digest identical. 137 of 137 touched rows re-read intact." The approval is `failed`. The action stays `proposed`, so "Simulate again on current data" re-runs the same action against the new reality.

In the eval, all 25 rollbacks and refusals were state-verified, and `rollback_left_changes` is 0.

## 2. Compensating restoration (after commit, bounded)

After a commit, the database cannot roll back. Restoration is a **new action** that undoes the original as far as is still safe. It goes through the same gate: simulated, checked by policy, approved with its own binding and nonce, executed with the verifier.

Code: `RESTORE` in [src/templates.ts](../src/templates.ts).

### Source

The committed execution's journal is kept as its recovery record (`executions.recovery`) for **24 hours**, then expired by the idle purge (`recovery_status = 'expired'`). The workspace itself is deleted at the same age, taking simulation before-images and receipts with it. The record holds every before and after image the execution wrote. Only executions that are themselves not restorations get one.

### Plan

| Original effect | Restoration |
|---|---|
| DELETE | re-insert the before images, parent-first (`TABLES` order), **one statement per table** (`jsonb_populate_recordset`). An immediate FK is checked at the end of the statement, so customers that referred each other, even in a cycle, go back together. |
| UPDATE (possibly several times) | put the row back to its **first** before image |
| INSERT outbox, still `pending` | set to `cancelled`. It is never sent. |
| INSERT outbox, already `dispatched` | queue a `<topic>.compensate` message referencing it. Warning `IRREVERSIBLE`. |
| INSERT ledger entry | never deleted. A counter-entry `reversal_reinstated` with the negated amount is booked. |
| any other INSERT | delete it |

### Refusals (`RESTORE_CONFLICT`, `RESTORE_EXPIRED`, blocking)

Any one of these blocks the whole restoration. Nothing is half-restored.

- a deleted row's id is in use again;
- a deleted customer's e-mail now belongs to another customer;
- an updated row was changed or deleted since (its current stable image differs from the execution's last after image);
- a row the action inserted was deleted or changed since. For a queued message, only the dispatcher's `pending → dispatched` transition is expected; any other change to the message (payload, topic) blocks with "message changed since";
- the recovery record is expired or already used, or the execution was not committed.

Because restoration is simulated, these appear in the dry run, not halfway through the real thing. Execution then binds the row versions of every row it will touch, so a change between the restore simulation and its execution, for example the dispatcher sending a queued message, makes the approval stale (tested).

### What restoration cannot do

- **Unsend.** A message delivered to a provider stays delivered. The restoration queues a compensating message and says so in the plan and the receipt.
- **Restore what was never in this database.** Provider-side state, backups and analytics copies are listed as unknown in every report.
- **Undo after the window.** After 24 h the recovery record is gone, by design (bounded retention of erased personal data).
- **Reproduce volatile columns.** A restored row equals its before image in every column except `updated_at`, which `snd_touch` stamps with the time of the restoration. That is a record of the restoration, and the tests assert it.
- **Merge.** If anything it would touch has changed since, it refuses rather than overwrite newer data. The operator decides.

### Tests

`test/restore.test.ts`:

- `a committed deletion is restored exactly; queued messages are cancelled for real`: every business table equals its pre-execution snapshot (volatile `updated_at` excluded, and asserted to be the restoration time), every message is `cancelled`, and there are 0 deliveries;
- `restoration refuses when later changes conflict`;
- `after messages were delivered, restoration says so and queues compensations; delivered messages stay delivered`;
- `the dispatcher moving a message between restore simulation and execution makes the restore stale`;
- `recovery records expire, and an expired record cannot be restored`;
- `cancelling stale orders: refunds and voided labels block, the narrowed plan commits and restores` (and every order line's reserved quantity is released, including several lines of one product);
- `customers that referred one another in a cycle are restored together`;
- `a queued message changed after the original action blocks its restoration`.

In the eval, 15 of 15 committed actions were restored.
