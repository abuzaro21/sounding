# Execution state

Owner deadline: **2026-12-15**. Target readiness: 2026-12-10. Last updated: 2026-11-15.

Status values: **PASS** (evidence linked and re-runnable), **OPEN** (not done), **OWNER** (needs an action only the owner can take).

| Gate | | Status | Evidence |
|---|---|---|---|
| G1 | Independent concept and architecture review | PASS | [reviews/ARCH-A-claude.md](reviews/ARCH-A-claude.md), [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md) (Codex `gpt-6.1-sol`, read-only); decisions in [ARCHITECTURE-DECISIONS](ARCHITECTURE-DECISIONS.md) |
| G2 | Final product identity | PASS | Name SOUNDING, logo and palette in the UI; [README](../README.md) |
| G3 | Real action intent compilation | PASS | [ACTION-COMPILER](ACTION-COMPILER.md); `the compiler accepts only allowlisted shapes and bounded parameters`; e2e `the compiler refuses anything that is not an allowlisted request` |
| G4 | Actual stateful database and business records | PASS | PostgreSQL 16, 13 business tables with FKs and triggers ([src/schema.ts](../src/schema.ts)); seeded synthetic data per workspace |
| G5 | Real simulation with no durable effects | PASS | [SIMULATION-ENGINE](SIMULATION-ENGINE.md); `a simulation leaves no durable effect` (state digest and deliveries unchanged, from a new transaction) |
| G6 | Accurate direct and indirect impact diff | PASS | [EFFECT-MEASUREMENT](EFFECT-MEASUREMENT.md); `measured effects equal an independent SQL oracle, table by table`; eval 605/605 on commit, compared by key **and** images |
| G7 | Unsafe simulation changes the decision | PASS | Eval: 38/38 initial plans blocked, 38/38 narrowed plans then safe; naive projection recall 0.167; `an unsafe plan is blocked, cannot be approved, …` |
| G8 | Human approval, modification and rejection | PASS | [APPROVALS](APPROVALS.md); `two approvals of one simulation, wrong token, wrong operator, rejection, expiry`; `modifying the plan invalidates the earlier approval`; races tests |
| G9 | Actual authorized database mutation | PASS | `an approved, fresh plan executes for real and the receipt matches the database`; live-check `execution committed with every check passing` |
| G10 | Transaction rollback on unexpected effects | PASS | [FAILURE-TEST](FAILURE-TEST.md) §1–3; eval 15 rolled back, `rollback_left_changes` 0 |
| G11 | Compensating restoration with documented limitations | PASS | [ROLLBACK](ROLLBACK.md); `test/restore.test.ts` (8 tests); eval 15/15 restorations committed |
| G12 | Concurrent execution and freshness safety | PASS | [CONCURRENCY](CONCURRENCY.md); `test/races.test.ts` (9 tests); eval 40/40 replays and 40/40 concurrent duplicates refused, 0 double executions |
| G13 | Real failure-test evidence | PASS | [FAILURE-TEST](FAILURE-TEST.md); eval 25/25 drifts caught, 0 false-safe commits |
| G14 | Security and session isolation | PASS | [SECURITY](SECURITY.md); `test/http.test.ts`, `test/net.test.ts`, RLS on business and control tables. Accepted risk: single DB role (ADR-007) |
| G15 | Polished browser UX and accessibility | PASS | Playwright desktop 1440×1000 and Pixel 7, 6/6; screenshots in [evidence/screens/](evidence/screens/), embedded in the README with a recorded demo clip |
| G16 | CI, clean clone, audit and Docker verification | OPEN | Clean clone of `a522ac7` through `scripts/ci.sh` (2026-11-15): `npm ci`, typecheck, build, 55/55 tests, eval reproduced byte for byte, e2e 6/6, `npm audit` 0 vulnerabilities, Docker build and smoke 18/18, "CI PASSED". Open: green GitHub Actions run on the public repo |
| G17 | Live deployment and restart testing | OWNER | Needs a Render workspace that holds no other application ([DEPLOY](DEPLOY.md#status)) |
| G18 | Finished 90-second film | PASS (machine checks) · OWNER (human review) | 89.9 s, 1920×1080, 30 fps, H.264/AAC, −16.4 LUFS, Kokoro narration, 41 burned-in captions plus SRT, real Playwright footage, logo animation. 10/10 automated checks, Whisper word error rate 0.5 %: [evidence/film-verification.json](evidence/film-verification.json). Built by `film/capture.ts`, `film/assemble.ts`, checked by `film/verify.py`. SHA-256 `631d5f4e…5f4b`. **No person has watched or listened to it yet.** Attached to the release, not committed |
| G19 | Release and submission-ready package | OPEN | [SUBMISSION](SUBMISSION.md) |

## Codex reviews

| Review | Scope | Reviewed | Findings | Status |
|---|---|---|---|---|
| ARCH-B | concept and architecture | before code | see file | incorporated |
| R2–R3–R8 | simulator, side effects, eval honesty | `42faa18` | 7 | 7 fixed in `60b23b7` |
| R4–R5–R6 | approvals, execution, rollback, concurrency | `42faa18` | 12 | 11 fixed, 1 claim narrowed, in `60b23b7` |
| R7 | API security, isolation | `42faa18` | 10 | 9 fixed in `60b23b7`, 1 accepted risk (ADR-007) |
| R9 | final diff `42faa18..60b23b7` | `60b23b7` | 11 | 11 fixed in `9f31314`; R10 found R9-3/4/5 partial |
| R10 | verification `60b23b7..9f31314` | `9f31314` | 8 complete, 3 partial, 1 new | all 4 fixed in `8d8bd3f`, not Codex-reviewed |

The fixes in `60b23b7` were made after the reviews of `42faa18`; R9 reviewed them. R10 reviewed the R9 fixes (`9f31314`). **The R10 fixes (`8d8bd3f`) were made after R10 and have not been reviewed by Codex.** Their evidence is the tests named in [R10-codex.md](reviews/R10-codex.md).
