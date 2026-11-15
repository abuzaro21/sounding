# Codex review R10: verification of the R9 fixes

| | |
|---|---|
| Reviewer | Codex CLI, model `gpt-6.1-sol` (from the run's own header), provider openai |
| Mode | `sandbox: read-only`, `approval: never`, reasoning effort high |
| Session | `01a1e0d1-22be-7d42-96d2-92a8252a0dfc` |
| Reviewed | `git diff 60b23b7 9f31314 -- src test` |
| Prompt | [R10-codex.prompt.md](R10-codex.prompt.md) |

R10 found 8 of the 11 R9 fixes complete, 3 partial, and 1 new defect. **The fixes below were made after R10, in commit `8d8bd3f`, and were not reviewed by Codex.**

## Triage

| Finding | Claim | Verdict | Change | Test |
|---|---|---|---|---|
| R9-1, 2, 6–11 | Complete | Verified by R10 | none | as in R9 |
| R9-3 partial | Guard matches constraint names in any schema | Confirmed. Fixed | Each of the nine required unique and composite-FK constraints is looked up on its own table (`to_regclass`), plus the one-approval-per-simulation index | checked by hand: dropping `executions_workspace_id_action_id_fkey` makes start-up refuse |
| R9-4 partial | Quota overshoot is not bounded by 3: drift bypasses the gate | Confirmed. Fixed; the earlier "accepted" note withdrawn | Quota is now reserved by one conditional `UPDATE workspaces … where used < limit`, before the write; Reset zeroes it | `a workspace has a bounded history`: 5 concurrent drifts at the last slot, exactly 1 succeeds, no overshoot |
| R9-5 partial | Validator and pg read the URL differently | Confirmed. Fixed | The check uses `pg-connection-string`, the parser pg itself uses (already installed; now a direct dependency at the same version) | `an external Render database URL must request TLS` (repeated `sslmode`, `?host=` override) |
| New, Medium | Malformed URL leaks its password in the start-up error | Confirmed. Fixed | Parse errors are replaced by a fresh error without the URL | same test (`hunter2-secret` never appears in the error) |

## Codex output, verbatim

Local absolute paths in links were made repository-relative; nothing else was changed.

Eight fixes are complete; R9-3, R9-4 and R9-5 are partial.

| Finding | Verdict and evidence at `9f31314` |
|---|---|
| **R9-1** | **Complete.** Bookkeeping rewrite rules block coverage; non-view rules enter the fingerprint: [db.ts:109](src/db.ts:109), [db.ts:116](src/db.ts:116). |
| **R9-2** | **Complete.** Reachable OIDs resolve across namespaces, and uncaptured tables block: [db.ts:105](src/db.ts:105). |
| **R9-3** | **Partial.** The refusal guard checks two constraint **names globally**, without qualifying their tables/schema. An old active schema passes if another schema supplies those names; other required composite FKs are unchecked. Validate every required constraint against its actual relation and definition: [schema.ts:312](src/schema.ts:312). |
| **R9-4** | **Partial.** Failed approvals now remain covered by uniqueness: [schema.ts:174](src/schema.ts:174). However, the accepted “at most three” quota overshoot is incorrect: drift bypasses `#gate`, and quota checking precedes writing: [engine.ts:554](src/engine.ts:554). An in-memory concurrency probe admitted five drift calls at count 39, ending at 44 against limit 40. Make quota reservation and durable writes atomic. |
| **R9-5** | **Partial.** Validation and `pg` parse different effective configurations: [db.ts:17](src/db.ts:17). Offline probes confirmed plaintext remains accepted with `?sslmode=verify-full&sslmode=disable`, or a localhost URL containing `?host=dpg-x.render.com`. Validate the effective host/TLS settings using the same parser as `pg`, or reject ambiguous overrides. |
| **R9-6** | **Complete.** Failure receipt insertion and approval update now share a transaction under the execution lock; conflicts return the existing receipt: [engine.ts:497](src/engine.ts:497). |
| **R9-7** | **Complete.** Recovery consumes only committed receipts and fails other terminal statuses: [engine.ts:536](src/engine.ts:536). |
| **R9-8** | **Complete.** Revocation targets strictly older simulations using the same total order as approval: [engine.ts:283](src/engine.ts:283), [engine.ts:315](src/engine.ts:315). |
| **R9-9** | **Complete.** The statement timeout exceeds the reconciliation lock wait, and periodic recovery handles unresolved approvals: [engine.ts:453](src/engine.ts:453), [main.ts:25](src/main.ts:25). |
| **R9-10** | **Complete.** Recovery defers `55P03` lock contention: [engine.ts:544](src/engine.ts:544). |
| **R9-11** | **Complete.** Committed restoration receipts include irreversible effects: [engine.ts:421](src/engine.ts:421). |

**New defect — Medium: malformed database URLs leak credentials into startup logs.** The added `new URL(url)` throws an error retaining the complete URL in `error.input`: [db.ts:17](src/db.ts:17). For `postgres://u:password@[broken/db`, Node’s uncaught startup error prints the password. A subprocess probe confirmed disclosure; the existing `pg` parser redacts this field. Smallest fix: catch URL parsing errors and throw a fresh sanitized error without attaching the original error.

No files modified. Offline probes and three network unit tests passed; PostgreSQL integration/race tests were not run, so SQL verdicts remain source-based.
