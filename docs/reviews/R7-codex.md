# Codex review: R7 security and tenant isolation

| | |
|---|---|
| Reviewer | Codex CLI, model `gpt-6.1-sol` (from the run's own header), provider openai |
| Mode | `sandbox: read-only`, `approval: never`, reasoning effort high |
| Session | `01a1e08b-74a4-7302-8c5a-fcae28c83983` |
| Reviewed | commit `42faa18` |
| Prompt | [R7-codex.prompt.md](R7-codex.prompt.md) |

**Every fix below was made after this review, in commit FIX_COMMIT, and was not reviewed by Codex in this pass.** The final diff review (R9) covers them.

## Triage

Each finding was checked against the code before it was fixed.

| Finding | Claim | Verdict | Change | Test |
|---|---|---|---|---|
| 1 High | Per-workspace storage unbounded | Confirmed. Fixed | Quota: 40 simulations, 120 actions, 40 drift events per workspace; Reset clears it | `a workspace has a bounded history` |
| 2 High | TLS verification disabled for render.com hosts | Confirmed. Fixed | Heuristic removed; TLS follows `sslmode` with verification | none (configuration; checked by reading `src/db.ts`) |
| 3 Medium | Reset bypasses limiter and admission gate | Confirmed. Fixed | Reset uses the expensive-request limiter and the shared gate | none specific |
| 4 Medium | Workspace capacity races insertion | Confirmed. Fixed | Count, check and insert under one advisory lock | `workspace capacity holds under concurrent session creation` |
| 5 Medium | Busy execution consumes its approval | Confirmed (same as R6-5). Fixed | Admission before the claim | `a busy server refuses execution …` |
| 6 Medium | No RLS on the control plane | Confirmed. Fixed | RLS forced on every control table; `workspaces` policy on `id` | `workspaces are isolated …` now loops over every control table |
| 7 Medium | Control-plane FKs not tenant-qualified | Confirmed. Fixed | Composite `(workspace_id, id)` FKs across actions, simulations, approvals, executions | `workspaces are isolated …` (cross-tenant approval insert fails on the FK) |
| 8 Medium | Runtime role owns the schema | Confirmed. **Accepted risk** | Render free offers one database user. Documented in ADR-007 and SECURITY; the fingerprint refuses execution after any schema change, and visitors cannot issue DDL | n/a |
| 9 Low | `/api/records` does not mask nested e-mail | Confirmed. Fixed | `maskRow` masks `payload.email`. Writing the test also exposed that `ob_`/`le_` ids were rejected by the id filter; fixed | `the whole gate works over HTTP, and personal data is masked …` |
| 10 Low | No tests for the 3-hop proxy chain or limiter overflow | Confirmed. Fixed | New `test/net.test.ts` | `three trusted hops …`; `every spelling of one address is one key`; `the memory cap never renews a budget` |

## Codex output, verbatim

Local absolute paths in links were made repository-relative; nothing else was changed. The full run log is kept locally and not published, because it contains local paths.

Reviewed commit `42faa18`. Findings are source-verified; database and deployment behavior were not exercised.

1. **High — [src/engine.ts:250](src/engine.ts:250): Per-workspace storage can grow without bound despite the workspace cap.**  
   **Scenario:** Repeatedly simulate the same proposed action at the permitted rate: each request permanently stores another complete effects/report copy and audit event. Requests refresh `last_seen`, preventing idle cleanup; simulation expiry never deletes evidence. Repeated `new_order` drift also grows business tables without a quota (`:471`). One visitor can exhaust the shared database.  
   **Smallest fix:** Enforce an atomic per-workspace storage/row budget covering history and drift inserts, with retention cleanup for expired evidence.

2. **High — [src/db.ts:18](src/db.ts:18): Render-host connections can disable PostgreSQL server authentication.**  
   **Scenario:** Configure a `postgres://…@db.example.render.com/db` URL without SSL query parameters. The effective installed `pg` configuration retains `rejectUnauthorized: false`, allowing an on-path attacker’s certificate to impersonate PostgreSQL and intercept tenant queries. This configuration was confirmed without connecting.  
   **Smallest fix:** Remove unconditional certificate-verification disabling; require certificate and hostname validation, supplying a CA where necessary.

3. **Medium — [src/http.ts:135](src/http.ts:135): Reset bypasses both the expensive-request limiter and global work admission limit.**  
   **Scenario:** A visitor sends concurrent resets across their sessions under the general 60-request burst. Each reset cascades deletion and reseeds every business table, with statement timeouts raised to 20 seconds (`src/engine.ts:72`). Resets can occupy all six pool clients independently of the three-operation simulation/execution limit, delaying unrelated tenants.  
   **Smallest fix:** Apply the expensive-request limiter to reset and admit reset/seeding through the shared concurrency gate before acquiring database resources.

4. **Medium — [src/engine.ts:61](src/engine.ts:61): Workspace capacity checking races with workspace insertion.**  
   **Scenario:** With 149 workspaces and a cap of 150, concurrent session requests independently count 149, then each seeds a new workspace. The configured cap is exceeded; an in-memory probe reproduced two creations with `maxWorkspaces: 1`.  
   **Smallest fix:** Serialize the count/check/insert in one transaction using a shared advisory lock.

5. **Medium — [src/engine.ts:315](src/engine.ts:315): A busy execution request consumes its approval before admission succeeds.**  
   **Scenario:** Three simulations occupy `#gate`. Executing a valid approval first commits its transition to `executing`, then `#gate` rejects with 503 (`:324`). Retrying returns “already executing”; no execution started and no receipt exists. Startup reconciliation is the only automatic repair.  
   **Smallest fix:** Acquire the gate before claiming the approval. Add a regression test asserting that busy rejection leaves it `approved`.

6. **Medium — [src/schema.ts:284](src/schema.ts:284): RLS excludes the entire control plane.**  
   **Scenario:** A transaction scoped to workspace B can directly select A’s simulation effects, execution recovery images, approvals, or audit events because those tables have no RLS policies. `rls_enforced` nevertheless reports true based solely on role attributes (`src/db.ts:73`). Current reviewed HTTP queries generally supply the necessary predicates; this is a missing database isolation layer, not a demonstrated cross-tenant HTTP bypass.  
   **Smallest fix:** Enable and force workspace policies on all tenant control tables, including an ID-based policy for `workspaces`; test cross-tenant reads and writes for each table.

7. **Medium — [src/schema.ts:151](src/schema.ts:151): Control-plane foreign keys do not enforce tenant consistency.**  
   **Scenario:** The schema accepts a simulation belonging to B that references A’s action, or B’s approval referencing A’s simulation. Deleting A’s parent can then cascade through B’s control records. Business-table composite FKs prevent this class of mismatch, but control-plane references use globally unique IDs alone. Current HTTP writers do not intentionally construct these mismatches.  
   **Smallest fix:** Add `(workspace_id, id)` uniqueness and tenant-qualified composite FKs between actions, simulations, approvals, and executions.

8. **Medium — [scripts/db-init.sql:3](scripts/db-init.sql:3): Runtime credentials retain the schema-changing authority explicitly excluded by the intended design.**  
   **Scenario:** The application role owns the database and runs migrations itself (`src/main.ts:13`), consequently owning the created tables and functions. A connection using those credentials can disable capture triggers, alter policies, or write the journal directly; the tests themselves disable a trigger through this role (`test/simulate.test.ts:107`). `NOSUPERUSER NOBYPASSRLS` does not remove ownership privileges.  
   **Smallest fix:** Separate migration ownership from runtime credentials and grant runtime only the required operations, using controlled capture functions for journal writes.

9. **Low — [src/engine.ts:551](src/engine.ts:551): Record responses bypass nested email masking.**  
   **Scenario:** Commit a customer purge, obtain an outbox ID from `/api/state`, then request `/api/records?table=outbox&ids=<id>`. `payload.email` contains the complete erased customer email because `maskRow` only masks top-level `email`. Simulation responses mask that same payload correctly. The supplied data is synthetic, limiting present exposure.  
   **Smallest fix:** Reuse the payload-aware masker for record responses and test the committed outbox path.

10. **Low — [test/http.test.ts:18](test/http.test.ts:18): Security tests omit the deployed proxy configuration and limiter overflow behavior.**  
    **Scenario:** Every HTTP test uses `trustProxyHops: 0`, while deployment specifies three hops. A regression selecting a spoofable leftmost forwarding address would leave the existing suite green. No repository tests exercise address normalization or overflow-bucket budget preservation either.  
    **Smallest fix:** Add focused tests for three-hop chains with attacker-prepended addresses, short chains, address aliases, and limiter overflow without budget renewal.

## Verified sound

- **Request authority:** Visitor values remain SQL parameters. Record tables are allowlisted; drift kinds select fixed branches. Template, restoration-table, and restoration-column identifiers are constrained. Database URLs and external endpoints are not visitor-selectable.
- **Filesystem access:** Static paths are decoded, resolved, and checked against the public-directory boundary before reading (`src/http.ts:76`). Reviewed deployment assets provide no visitor-controlled symlink creation path.
- **HTTP tenant scoping:** Cookies resolve through a parameterized hash lookup. Reviewed action, simulation, execution, records, drift, and state paths derive workspace authority server-side. No direct cross-visitor HTTP access was found. Wildcard maintenance context is not visitor-selectable.
- **Sessions and CSRF:** Sessions use 32 random bytes and store SHA-256 hashes. Cookies are HttpOnly, SameSite=Strict, and Secure in production. Mutations require the custom header; responses grant no CORS permission. The UI uses same-origin credentials.
- **Bounds and errors:** Parsed JSON bodies enforce 16 KiB declared and streamed limits; exclusions, edits, and record selections have downstream caps. Transactions set local workspace context and statement/lock timeouts. Generic HTTP errors hide stacks; CSP restricts scripts and connections to self.
- **Network limiter logic:** In-memory checks passed for trusted-hop indexing, prepended-address resistance, short-chain handling, selected IP aliases, and shared overflow budgets.

Not run: database, HTTP integration, Docker, load, or live proxy tests; probes used only in-memory objects. Deployment proxy topology remains unverified.
