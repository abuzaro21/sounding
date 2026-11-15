# SOUNDING

**Simulation-gated bulk data changes.** An agent proposes a bulk mutation. SOUNDING runs it for real inside a PostgreSQL transaction that can only roll back. It measures every row the mutation changes, directly or by cascade, trigger, `SET NULL` or queued external message. It blocks plans that break policy, has the agent narrow them, and simulates again. Only a fresh plan that passes policy and that a human approved, bound to its exact evidence, can execute. Execution runs again, and an in-transaction verifier rolls it back if reality differs from the approved simulation.

This is not a confirmation dialog. The approval screen shows what happened in the dry run. The approval is a cryptographic binding to that measured effect set, and execution refuses to commit anything else.

```
INTENT → SIMULATE → MEASURE CONSEQUENCES → REVIEW → APPROVE / MODIFY / REJECT → EXECUTE → VERIFY → ROLLBACK OR RECOVER
```

Built for the DOO Builders League challenge "Simulate before you act".

![Recorded demo: a customer phones in an order after approval; execution finds 3 changes nobody approved and rolls back before commit](docs/evidence/demo-drift-rollback.gif)

*Recorded from the real app (14 s, captions burned in). The full 90-second film, `sounding-film.mp4`, with its SRT is attached to the [v1.0.0 release](../../releases/tag/v1.0.0).*

## What you see in the demo

Every visitor gets an isolated synthetic copy of *Larkspur Outfitters*, a fictional outdoor-gear shop with 13 business tables. Nothing in it is real.

1. **Ask.** "Remove inactive customer accounts older than 18 months." The agent expects to delete 48 customer rows.
2. **Simulate.** The dry run measures **289 row changes in 10 tables**: orders, invoices, payments, shipments, subscriptions and addresses deleted by cascade; support cases orphaned by `SET NULL`; active customers silently edited through a referral self-FK; and messages queued to CRM, billing, carrier and helpdesk providers. Afterwards every business table has the same row count and content hash as before, and the report shows the proof.
3. **Blocked.** Policy `larkspur-2026.11-r1` finds unpaid invoices, active subscriptions, shipments in transit, open support cases and financial records inside the 7-year retention period. The plan cannot be approved.
4. **Narrow.** The agent excludes the customers each finding traces back to (28 targets, 134 effects) and simulates again. Safe.
5. **Approve.** The approval is an HMAC over the effect digest, spec hash, schema fingerprint, row versions, policy version and operator. It carries a one-time nonce and expires in 5 minutes.
6. **Reality moves.** Click "a customer phones in an order" before executing. Execution runs the same mutation. The verifier sees 3 row changes the approval never covered and **rolls back before commit**. A fresh transaction then proves the state is identical, with every touched row re-read intact (137/137).
7. **Re-simulate, narrow, commit.** The receipt lists every check, the pre- and post-state digests, and the effect count.
8. **Restore.** The compensating restoration goes through the same gate: it is simulated, approved and verified. Queued messages are cancelled for real. Delivered ones get a compensating message, and the receipt says that they could not be unsent.

| Blocked: what the dry run really measured | Approved, then reality moves |
|---|---|
| ![Blocked plan with the measured impact graph and policy findings](docs/evidence/screens/desktop-1-blocked.png) | ![Approval binding with the drift buttons](docs/evidence/screens/desktop-2-approved-drift.png) |
| **Rolled back before commit** | **Committed and verified** |
| ![The verifier stopped the execution inside the transaction](docs/evidence/screens/desktop-3-incident.png) | ![Receipt with every check passed](docs/evidence/screens/desktop-4-committed.png) |

More, including phone-width captures: [`docs/evidence/screens/`](docs/evidence/screens/).

## Measured, not claimed

From [`docs/evidence/eval.json`](docs/evidence/eval.json). 40 seeded scenarios with random scopes, operator exclusions and three kinds of drift run against real PostgreSQL. The output is deterministic, and CI fails if it changes.

| | |
|---|---|
| Effect set on commit, predicted vs actual | 605 / 605 (precision 1, recall 1) |
| Recall of the agent's own naive projection | 0.167 |
| Initial plans blocked / narrowed plans then safe | 38 / 38 |
| Blocking rows prevented | 866 (distinct rows) |
| Drift injected after approval / caught before commit | 25 / 25 |
| False-safe commits under drift | 0 |
| Rollbacks or refusals with state re-verified identical | 25 |
| Replays and concurrent duplicates refused | 40 / 40 |
| Double executions | 0 |
| Restorations committed | 15 |
| Unapproved rows a blind executor would have changed | 65 |

Precision and recall of 1 on commit are **guaranteed by construction**: the verifier refuses to commit any effect set that differs from the approved one. This is not evidence of predictive skill. The informative numbers are the 25 drifts, all caught, and the 0.167 recall of what an agent would have predicted without the simulator. See [docs/FAILURE-TEST.md](docs/FAILURE-TEST.md).

## Run it

Requirements: Node 24.13+, Docker.

```bash
docker compose up -d --wait db           # PostgreSQL 16 on 127.0.0.1:55432 with a non-superuser app role
npm ci
npm run build                            # the UI, into public/
DATABASE_URL=postgres://app:app@127.0.0.1:55432/sim PORT=3100 npm start
```

Open http://127.0.0.1:3100.

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://app:app@127.0.0.1:55432/sim_test npm test   # 35 node tests
npm run test:e2e                         # Playwright, desktop and mobile
npm run eval                             # regenerates docs/evidence/eval.json
node scripts/live-check.ts http://127.0.0.1:3100   # 18 HTTP checks against any deployment
npm run ci                               # everything above, plus npm audit and a Docker smoke test
```

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, data model, request flow |
| [ARCHITECTURE-DECISIONS](docs/ARCHITECTURE-DECISIONS.md) | ADRs, with the trade-offs taken |
| [SIMULATION-ENGINE](docs/SIMULATION-ENGINE.md) | The rollback-only dry run and its durability proof |
| [EFFECT-MEASUREMENT](docs/EFFECT-MEASUREMENT.md) | The capture journal, effect keys, causes, digests |
| [IMPACT-GRAPH](docs/IMPACT-GRAPH.md) | The consequence canvas, and attribution of effects to targets |
| [ACTION-COMPILER](docs/ACTION-COMPILER.md) | Plain words to an allowlisted template, never SQL |
| [APPROVALS](docs/APPROVALS.md) | Binding, nonce, expiry, single use, invalidation |
| [EXECUTION-VERIFICATION](docs/EXECUTION-VERIFICATION.md) | The checks, in order, and what each one catches |
| [ROLLBACK](docs/ROLLBACK.md) | Pre-commit rollback, and compensating restoration with its limits |
| [FAILURE-TEST](docs/FAILURE-TEST.md) | Under-prediction tests and the evaluation |
| [CONCURRENCY](docs/CONCURRENCY.md) | Races, locks, replays, lost commits, crashes |
| [SECURITY](docs/SECURITY.md) | Threat model and the public surface |
| [DEPLOY](docs/DEPLOY.md) | Render free tier, database continuity |
| [THESIS](docs/THESIS.md) | Why simulation-gated agents become the standard by 2028 |
| [AI-DISCLOSURE](docs/AI-DISCLOSURE.md) | What AI wrote and what was reviewed |
| [EXECUTION_STATE](docs/EXECUTION_STATE.md) | Gates G1–G19 with evidence |
| [reviews/](docs/reviews/) | Architecture competition and adversarial Codex reviews |

## Honest limits

- The simulator observes one PostgreSQL database. Backups, replicas, WAL, analytics exports and anything a provider does after it receives a message are listed in every report as **unknown**, never as simulated.
- External effects are **modeled** from the outbox rows the dry run actually wrote and from documented provider contracts. Nothing leaves the database during a simulation. In the demo, a dispatcher writes delivered messages to a local `deliveries` table after a 60-second hold; no real provider exists.
- Restoration is a compensating action, not time travel. It refuses if anything it would touch changed after the original execution. Recovery records expire after 24 hours.
- The action vocabulary is two templates (purge inactive customers, cancel stale orders) plus restoration. The gate is general. The templates are deliberately narrow.
- In the demo, one database role owns the schema and runs the app. Production would split the migration and runtime roles. The schema-fingerprint check refuses execution if the schema changed after the simulation.

## License

MIT. See [LICENSE](LICENSE). All business data is synthetic.
