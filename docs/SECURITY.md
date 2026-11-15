# Security

## What a visitor can and cannot do

A public visitor can send a plain-language request, choose which of two templates to run with a bounded number, exclude targets by id, approve or reject, trigger three named kinds of drift, and reset. All of it happens in their own synthetic workspace.

A visitor **cannot** supply:

| Input | Why it is impossible |
|---|---|
| SQL | No endpoint takes SQL. The compiler refuses anything outside two grammar shapes and a plain-word charset ([ACTION-COMPILER](ACTION-COMPILER.md)). All mutations are fixed, parameterised queries in `templates.ts`. |
| A database URL | `DATABASE_URL` comes from the environment only. No request field is read as a connection target. |
| A table or column expression | `/api/records?table=` is checked against the `TABLES` allowlist. Control tables (`workspaces`, `approvals` …) are not on it. Identifiers in restoration SQL pass `ident()` (`^[a-z_][a-z0-9_]*$`) and `tableOf()` (allowlist). |
| A filesystem path | Static serving resolves inside `public/` and refuses anything outside, including encoded `..`. Tested with `/..%2f`, `/%2e%2e/` and `/../../etc/passwd`. |
| An endpoint or provider URL | Providers are names in a constant map. The dispatcher writes `deliveries` rows; it makes no network calls. |
| Another workspace | See isolation, below. |
| Test hooks | `Engine.hooks` are object properties set only by test code. No route, header, body field or environment variable reaches them. |

## Isolation

Three independent layers:

1. **Session to workspace.** The cookie `snd_sid` is 32 random bytes, `HttpOnly; SameSite=Strict; Secure` in production, and expires after 12 h. The server stores only its SHA-256. Each request resolves exactly one workspace from it, and every engine call is scoped to that workspace.
2. **Query scope.** Every query filters `workspace_id = $1`. All business keys are `(workspace_id, id)` with composite FKs, so cascades cannot cross workspaces.
3. **Row-level security.** Every business and control table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with the policy `workspace_id = current_setting('snd.ws')`; the `workspaces` table itself has the same policy on `id`. Control-plane foreign keys are composite `(workspace_id, …)`, so an approval cannot reference another workspace's simulation, nor a receipt another workspace's approval. The setting is transaction-local and set by the server. The app connects as `app`, which is `NOSUPERUSER NOBYPASSRLS`. `/healthz` reports `rls_enforced`, and live-check fails if it is false. The value `'*'` is used only by server-internal maintenance (dispatcher, idle purge, start-up reconciliation), which no request can reach.

Tests: `workspaces are isolated: by query scope and by row-level security` (a raw query without the workspace filter, under another workspace's setting, sees nothing), and `another session cannot read or act on this workspace` (404 on every route, 409 "No such approval." even with the nonce, and B's same-id rows survive A's deletion).

## Request hardening

- **CSRF.** Every non-GET request needs `x-sounding: 1`. A cross-site form cannot set it, and a cross-site `fetch` with it needs a CORS preflight this server never grants. `SameSite=Strict` is the second layer.
- **Bodies.** JSON objects only, at most 16 KiB (413 above, 400 for arrays and non-JSON).
- **Ids.** Path ids must match `^[a-z]{3}_[0-9a-f]{12}$`, or the request gets 404.
- **Rate limits.** Token buckets per client address, which is IPv4 or the IPv6 /64, resolved behind exactly `TRUST_PROXY_HOPS` proxies (3 on Render):

  | Bucket | Rate | Burst |
  |---|---|---|
  | General | 8/s | 60 |
  | Simulate and execute | 0.5/s | 20 |
  | New workspaces | 1 per 30 s | 6 |

  Plus at most 3 concurrent heavy operations per process (simulate, execute, reset, workspace creation), checked **before** an approval is claimed, so a refused visitor keeps a usable approval. The bucket table is capped at 10 000 addresses; when it is full, unseen addresses share one overflow bucket and no existing budget is ever renewed. Also a cap of 150 workspaces (idle ones are purged first; the count and the insert happen under one advisory lock, so concurrent sessions cannot overshoot it), a history quota per workspace (40 simulations, 120 actions, 40 drift events), reserved by one conditional `UPDATE` before each write so concurrent requests cannot overshoot it; approvals are bounded by simulations (one each); Reset clears it, and statement (8 s; 10 s for execution), lock (3 s) and idle-in-transaction (20 s) timeouts on every transaction.
- **Headers.** CSP `default-src 'self'` with `frame-ancestors 'none'`, `object-src 'none'` and `base-uri 'none'`, plus `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP `same-origin` and a Permissions-Policy. API responses are `no-store`.
- **Errors.** Errors are generic 500 messages with no stack trace. Logs never contain request bodies.
- **Relaxed limits** (`SND_RELAXED_LIMITS=1`) exist for tests. The server refuses to start with them when `NODE_ENV=production`.

## Data

- Every business record is synthetic, generated from a seed. No real customer data is imported anywhere.
- Responses mask e-mail addresses (`xx***@domain`), including those inside outbox payloads, and drop `workspace_id`.
- Workspaces idle for 12 h are deleted with everything they own (FK cascade from `workspaces`, tested). No workspace lives longer than 24 h, the recovery window, so simulation before-images, receipts and recovery records of erased data are gone within that window plus one purge interval. Recovery records expire after 24 h.
- The audit log is a per-workspace SHA-256 hash chain (`prev_hash`, `hash` over the canonical event). `GET /api/audit` verifies it, and the tamper test proves that editing any event breaks it.

## Database connection

TLS follows the `sslmode` in `DATABASE_URL`, with certificate verification. An earlier version turned TLS on for any `render.com` host with `rejectUnauthorized: false`; that was removed. An external Render hostname (`*.render.com`) without TLS is refused at start-up, so it can never connect in plaintext. The check reads the URL with `pg-connection-string`, the parser pg itself uses, so overrides such as `?host=` or a repeated `sslmode` are judged as pg will apply them. A malformed URL produces an error that does not repeat it, because it holds the password. On Render the internal URL is used and stays inside Render's private network.

## Secrets

- `SND_SECRET` (approval HMAC key) is generated by Render (`generateValue`). Without it, a random per-process key is used, which invalidates open approvals on restart. That is safe.
- No secrets are in the repository. Before publishing, a secret scan (`git grep` for key, token and password patterns, and for private paths) came back clean. `docs/reviews/raw/` (Codex logs containing local paths) is git-ignored.
- `npm audit` runs in CI. Runtime dependency: `pg` only.

## Known limits

- The operator is the browser session. There is no account system, because every visitor operates only their own throwaway synthetic workspace.
- In the demo, one database role owns the schema and runs the app ([ADR-007](ARCHITECTURE-DECISIONS.md)). A visitor has no way to issue DDL, and the schema fingerprint refuses execution after any schema change. A production deployment should split the migration and runtime roles.
- The rate limiter is in memory and per process. That is enough for one free instance.
- A database created by an earlier schema version is not migrated: start-up refuses it and asks for it to be recreated. Every record is synthetic, so nothing is lost.
