# Action compiler

Code: `compile`, `expectation` and `revise` in [src/agent.ts](../src/agent.ts). Templates are in [src/templates.ts](../src/templates.ts).

The agent turns a plain-language business request into a structured action. It never produces SQL, and nothing a visitor sends becomes SQL. The only mutations that exist are the `apply` functions of three templates, with parameterised queries and bounded parameters.

## Grammar

`compile(intent)` accepts exactly two shapes and refuses everything else, rather than guessing:

| Shape (case-insensitive) | Template | Parameter | Bounds |
|---|---|---|---|
| remove / delete / purge / erase / clean up … inactive / dormant … customer(s) … older than / inactive for / for over / more than / over *N* month(s) / year(s) | `purge_inactive_customers` | `months` (years × 12) | 6–120 |
| cancel … stale / unpaid / pending … order(s) … older than / over / more than / for more than *N* day(s) / week(s) | `cancel_stale_orders` | `days` (weeks × 7) | 3–365 |

*N* is digits or one of a few number words. Before matching, the input is trimmed and whitespace collapsed, and it must:

- be at most 200 characters;
- match `^[A-Za-z0-9 ,.'’!?-]+$`, so no semicolons, quotes other than apostrophes, parentheses, operators or newlines;
- end with the period unit, optionally followed by `.` or `!`. Text the grammar did not read cannot ride along after the match.

Refusals are 422 with a reason. The UI shows the two examples. Tested in `the compiler accepts only allowlisted shapes and bounded parameters` and in e2e `the compiler refuses anything that is not an allowlisted request`.

The API also accepts `{template, params, exclude}` directly. `template` must be one of the two names, and `params` are coerced to numbers and checked against the same bounds by `resolve`. `restore_execution` is created only by `POST /api/executions/:id/restore`, from a committed execution in the same workspace.

## The action spec

```ts
{ template, params: { months | days | execution_id }, exclude: string[], target_ids: string[], mode }
```

- `resolve` runs the template's fixed selection (`status = 'inactive' and last_active_at < now() - make_interval(months => $2)`, or the orders equivalent) and **freezes** the result as `target_ids`. Execution mutates exactly these ids. It never re-evaluates "whatever matches now".
- `exclude` ids are validated against `^[a-z]{3}_[0-9a-z]{1,20}$`, de-duplicated and capped at 500.
- `spec_hash = sha256(canonical(spec))` is stored with the action and bound by the approval.

## The agent's expectation

`expectation(spec)` is what an agent writing `DELETE … WHERE` would predict: N rows in one table. It is shown next to the measured effect count, and the eval scores it (`naive_agent_projection_recall` 0.167). The gap is the reason the simulator exists.

## Narrowing (MODIFY)

`revise(spec, policy)` runs after a blocked simulation:

1. Take each blocking finding. Every finding names the target records it is attributed to (`roots`, see [IMPACT-GRAPH](IMPACT-GRAPH.md)).
2. If any blocking finding has no roots (EMPTY, LIMIT) narrowing cannot help, so return null and the UI offers Reject or Change scope.
3. Exclude every root, plus targets that `TARGET_DRIFT` says no longer match.
4. Return the new exclusion list and a rationale in terms of measured rows, such as "I am excluding 20 customers: 14 for open obligation (31 rows); 17 for financial retention (52 rows)".

The revision is a **new action**. It is resolved again from current data, gets a new spec hash, and must be simulated before anyone can approve it. The old action is marked `superseded` and any approval of it is revoked. The agent can propose and narrow. It cannot approve or execute: approval requires the operator's session, and the agent identity `agent:planner-v1` never holds one.

The operator can also modify directly: change the period, or tick targets to exclude in the Proposal panel (`POST /api/actions/:id/edit`). That too creates a new action.
