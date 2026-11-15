# DOO submission package

Challenge: **DOO Builders League: Simulate Before You Act**. "Can an AI system think through consequences before it changes something?"

Status: **not submitted.** The owner fills in and sends the DOO form. Only the form's confirmation counts as submission.

## Form fields

| Field | Value |
|---|---|
| Project name | SOUNDING |
| Tagline | See the consequences before they become real. |
| One-line description | An agent's bulk data change runs for real inside a rollback-only PostgreSQL transaction; every direct and indirect row change is measured, unsafe plans are blocked and narrowed, and only a human-approved plan bound to its exact evidence executes, under a verifier that rolls back anything the simulation did not predict. |
| Repository | https://github.com/abuzaro21/sounding |
| Release | https://github.com/abuzaro21/sounding/releases/tag/v1.0.0 |
| Live demo | https://sounding.onrender.com (free tier: the first request after idle takes about a minute) |
| Video (YouTube, Unlisted) | _pending: owner uploads `sounding-film.mp4` from the v1.0.0 release (SHA-256 `631d5f4e4a379a7cc490bb4ca54c3e64ef208e971d20d99461bcbf99169c5f4b`)_ |
| Thesis | [THESIS.md](THESIS.md) (≤ 300 words) |
| AI disclosure | [AI-DISCLOSURE.md](AI-DISCLOSURE.md) |

## Description (for the form, about 180 words)

> An AI agent is asked to "remove inactive customer accounts older than 18 months". It expects to delete 48 rows. SOUNDING runs that exact mutation inside a PostgreSQL transaction that can only roll back, and measures what really happens: 289 row changes across 10 tables, by cascade, `SET NULL`, triggers and messages queued to outside providers. Policy blocks the plan. The agent narrows it from the evidence and simulates again until it is safe.
>
> A human approves the measured effect set, not a summary. The approval is an HMAC over the effect digest, schema fingerprint and row versions, with a 5-minute, single-use nonce. Execution re-runs the same mutation, and an in-transaction verifier compares reality with the approval. When a customer places an order between approval and execution, the verifier sees 3 changes the approval never covered and rolls back before commit. A fresh transaction then proves the state is unchanged.
>
> Across 40 seeded scenarios: effects on commit matched predictions 605/605, 25 of 25 drifts were caught, and there were 0 false-safe commits.

## What a judge can verify in five minutes

1. Open the live demo, or run `npm run db:up && npm run build && npm start` locally.
1. Follow the eight steps in the [README](../README.md#what-you-see-in-the-demo). Press **Reset** at any time.
2. Read a receipt: every check, the digests, the effect count.
3. Run the eval: `npm run eval`. The numbers must equal [evidence/eval.json](evidence/eval.json).

## Owner-only actions

1. Watch and listen to the film end to end; then upload it to YouTube as **Unlisted**.
2. Submit the DOO form; record the confirmation here.
3. Before the free database expires on **2026-12-15 21:47 UTC**: the continuity steps in [DEPLOY](DEPLOY.md#database-continuity).
