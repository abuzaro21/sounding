# Approvals

Code: `Engine.approve`, `Engine.execute` (claim), `#supersede` and `reject` in [src/engine.ts](../src/engine.ts).

An approval is not a click recorded somewhere. It is a signed statement: *this operator approves exactly this measured effect set, on this schema and these row versions, under this policy, until this time, once.*

## Preconditions

`approve` refuses (409) unless:

- the action is still `proposed` (not superseded, rejected or executed);
- the simulation's verdict is `safe`. A blocked plan cannot be approved, and the UI offers no Approve button for it;
- the simulation is younger than 10 minutes;
- it is the **latest** simulation of that action;
- the simulation has no approval yet (unique index; a second approve returns `already-approved`).

## The binding

```json
{
  "workspace": "...", "operator": "<session operator id>",
  "action_id": "...", "spec_hash": "sha256(canonical(spec))",
  "simulation_id": "...", "effect_digest": "...", "effects": 134,
  "schema_fp": "...", "row_versions": "sha256(canonical(row versions))",
  "policy_version": "larkspur-2026.11-r1",
  "expires_at": "<now + 5 min>", "nonce_hash": "sha256(nonce)"
}
```

`binding_hash = HMAC-SHA256(SND_SECRET, canonical(binding))`. The server keeps the binding, its HMAC and `sha256(nonce)`. The **nonce** (18 random bytes, base64url) is returned to the approving client once and never stored in the clear.

The UI shows the binding as a card: the digest, effect count, a live countdown to expiry and the nonce.

## Single use

Execution begins by claiming the approval in one statement:

```sql
update approvals set status = 'executing'
 where workspace_id = $1 and id = $2 and nonce = sha256($nonce)
   and status = 'approved' and expires_at > now() and operator = $operator
returning *
```

Only one caller can move a row from `approved` to `executing`. A double click, a replay, a second tab or a concurrent request gets 409 `approval-unusable`, with the reason: "No such approval", "belongs to another operator session", "already executing / consumed / failed; approvals are single-use", "expired" or "token does not match". An approval of another workspace is indistinguishable from one that does not exist.

The claim happens only after the server admits the request; a `503 busy` leaves the approval `approved`. After the claim, the approval ends as `consumed` (committed) or `failed` (refused or rolled back). It never returns to `approved`. A failed execution needs a new simulation and a new approval.

## Invalidation

- **Modify.** Narrowing by the agent, or an edit by the operator, supersedes the action and sets any open approval of it to `rejected` ("superseded by a modified action").
- **Reject.** Rejects the action and revokes its approvals.
- **Re-simulate.** Simulating an action again revokes every live approval of its older simulations. Execution also requires its simulation to still be the latest one.
- **Races.** Edit, reject and execution take the same action row lock. An edit or rejection that arrives while the action is executing waits, then gets 409 "This action is no longer open".
- **Expiry.** Enforced in the claim (`expires_at > now()`).
- **Staleness.** Execution rebuilds the binding from the stored records (effect digest recomputed from the stored effects, spec hash recomputed from the stored action) and compares it with the signed one, then checks the HMAC. Evidence swapped in storage under an intact signature is refused. Then, inside the execution transaction, it re-checks the schema fingerprint and the live row versions (see [EXECUTION-VERIFICATION](EXECUTION-VERIFICATION.md)).

## Tests

`test/execute.test.ts`:

- `two simultaneous executions of one approval: exactly one runs`
- `two approvals of one simulation, wrong token, wrong operator, rejection, expiry`
- `modifying the plan invalidates the earlier approval`
- `an old simulation cannot be approved`

`test/http.test.ts`: `another session cannot read or act on this workspace` (even holding the nonce). The eval refuses 40 of 40 replays and 40 of 40 concurrent duplicates.

## Who approves

The operator is the browser session, identified by an `HttpOnly; SameSite=Strict` cookie. In this demo every visitor is the operator of their own synthetic workspace. A production deployment would replace the session operator with real identity and role checks. The binding already carries the operator, so that change does not touch the gate.
