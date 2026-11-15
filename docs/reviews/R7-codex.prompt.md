You are an independent adversarial code reviewer for SOUNDING, a simulation-gated bulk data change system (Node 24 native TypeScript, PostgreSQL 16, React). The repository is the current directory, at git commit 42faa18. You are in a READ-ONLY sandbox: read any file, run read-only commands such as git show/grep, but do not modify files and do not attempt network or database access. Read docs/reviews/ARCH-B-codex.md for the intended design.

Report only defects you have verified by reading the code: correctness, safety and security bugs, false claims, and missing tests for claims the code makes. No style nits, no praise. For each finding give: severity (critical/high/medium/low), file:line, the defect in one sentence, a concrete failure scenario (inputs/state -> wrong result), and the smallest fix. Rank most severe first, at most 12 findings. Then a short section "Verified sound" listing the specific properties you checked and found correct, so the record shows coverage. Plain markdown, at most 1500 words.

SCOPE: review area R7 (API security and tenant isolation).
Files: src/http.ts, src/net.ts, src/main.ts, src/db.ts, src/engine.ts (every query: workspace scoping, records, drift, state), src/schema.ts (RLS policies, FORCE, composite FKs, roles), ui/src/api.ts, Dockerfile, render.yaml, scripts/db-init.sql, test/http.test.ts.
Questions to answer with evidence:
1. Can any request reach SQL, a table name, a database URL, a filesystem path or an external endpoint chosen by the visitor? Check every interpolated identifier (e.g. records table name, drift kind, static file path).
2. Can one visitor read or change another visitor's workspace, by id guessing, cookie handling, RLS gaps ('*' maintenance context), or a query missing workspace scoping?
3. Session and CSRF: token entropy and storage, cookie flags, the custom-header CSRF defence, SameSite, CORS. Rate limiting: proxy-hop handling for X-Forwarded-For spoofing, limiter memory growth, abuse of expensive endpoints (simulate/execute/reset/session creation), workspace cap.
4. Denial of service and resource exhaustion: body limits, statement timeouts, pool exhaustion, unbounded arrays (exclude/include/ids), large responses.
5. Information leakage: error messages, stack traces, unmasked emails or personal fields in any response, security headers and CSP.
