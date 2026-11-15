# Architecture decisions

Each record states the decision, the alternatives considered, and the cost accepted. The concept competition behind ADR-001 is in [reviews/ARCH-A-claude.md](reviews/ARCH-A-claude.md) and [reviews/ARCH-B-codex.md](reviews/ARCH-B-codex.md), written independently.

## ADR-001 — The domain is a bulk change to a relational database

**Decision.** Simulate bulk deletions and updates on a PostgreSQL database with a realistic, imperfect schema.
**Alternatives.** Deploy-plus-migration gating; a payment-refund batch against a sandbox PSP.
**Why.** It is the only option where the simulator *is* the mutation, run by the real engine, so measurement is exact and rollback is the database's own guarantee. The alternatives need a model of a system that cannot be fully observed.
**Cost.** External effects (CRM, billing, carrier) can only be modeled from the outbox. Every report says so.

## ADR-002 — The dry run is a rollback-only transaction, not a model

**Decision.** Execute the template's `apply` inside REPEATABLE READ, under a savepoint, flush deferred constraints, read the journal, roll back, then prove that nothing persisted.
**Alternatives.** `EXPLAIN`; a static FK-graph walk; a cloned database per simulation.
**Why.** `EXPLAIN` does not run triggers. An FK walk misses trigger logic, configuration-dependent paths (ledger mirroring) and deferred constraints. A clone per simulation is too slow and too costly on free hosting.
**Cost.** A simulation holds row locks for its duration (milliseconds to a few seconds). It is capped at 3 concurrent operations and a statement timeout.

## ADR-003 — Effects are measured with a row-level capture trigger

**Decision.** A `zzz_capture` row trigger on every business table writes before and after images to `change_log` when a capture id is set for the transaction.
**Alternatives.** Logical decoding / WAL (needs replication privileges and slots; not on the free tier); diffing table snapshots (cannot attribute repeated changes, and is slow).
**Why.** It sees cascades, `SET NULL`, trigger writes and deferred triggers, in order, inside the same transaction, with ordinary privileges.
**Cost.** A table without the trigger would be invisible, so coverage is checked before every simulation and execution. `TRUNCATE` is forbidden. Execution also checks row counts independently of the journal (check 7).

## ADR-004 — Targets are frozen at planning time

**Decision.** `resolve` turns the selection into an explicit id list stored in the spec. Execution mutates exactly those ids. Selection drift is reported as `TARGET_DRIFT`.
**Alternatives.** Re-evaluate the predicate at execution.
**Why.** A predicate re-evaluated later can match rows nobody reviewed. That is the classic "the WHERE clause matched more at 3 a.m." incident.
**Cost.** A record that newly qualifies is left out until the next plan. This is reported as a warning.

## ADR-005 — Approval binds evidence, not intent

**Decision.** The approval is an HMAC over the effect digest, spec hash, schema fingerprint, row-versions hash, policy version, operator and expiry, with a single-use nonce.
**Alternatives.** Approve the action id; approve the simulation id only.
**Why.** Approving an id lets any later version of reality ride on that approval. Binding the measured evidence means execution can check that it is doing what was approved.
**Cost.** Any drift requires a new simulation and approval. That is intended, and the UI makes it one click.

## ADR-006 — Verify inside the execution transaction, then commit

**Decision.** Run `apply` for real under SERIALIZABLE, compare the actual effects exactly with the approved ones, check row counts independently, run the policy again on the actual effects, and only then COMMIT.
**Alternatives.** Commit, then verify and compensate.
**Why.** Verifying before commit turns every under-prediction into a rollback, which is exact and free, rather than into a compensation, which is partial and visible to providers.
**Cost.** Zero tolerance: any column difference in any row rolls back. Clock-derived columns are excluded explicitly (`VOLATILE`).

## ADR-007 — Demo database roles

**Decision.** One non-superuser, non-BYPASSRLS role runs migrations at start-up and serves requests.
**Alternatives.** Separate migration-owner and runtime roles with DML-only grants.
**Why.** The free Render database provides one user. Visitors have no path to DDL: no SQL input, allowlisted identifiers, fixed templates.
**Cost.** Anyone holding the runtime credential could alter triggers or policies. Mitigations: the schema fingerprint (including trigger enabled state, RLS state, policies and function bodies) is bound to every approval, and capture coverage is checked on every run. A production deployment must split the roles. This is listed in SECURITY.md and was raised by Codex review R7.

## ADR-008 — Deterministic ids for trigger-created rows

**Decision.** `snd_id(prefix, parts)` derives ids from the action id and the row's content.
**Why.** Random ids would make every outbox row differ between simulation and execution, forcing either tolerance in the comparison or meaningless digests.
**Cost.** Outside an action, ids are random, as ordinary business writes should be.

## ADR-009 — Restoration is an action through the same gate

**Decision.** Undo after commit is a new `restore_execution` action, built from the recovery journal, simulated, approved and verified.
**Alternatives.** An "undo" button that replays the journal directly.
**Why.** Restoration is itself a bulk change to data that may have moved. It deserves the same evidence. Conflicts block it whole, rather than half-restoring.
**Cost.** Delivered messages cannot be unsent. Restoration queues compensations and labels them irreversible. The recovery window is 24 h.

## ADR-010 — Deterministic agent, no model API

**Decision.** The planner is a bounded grammar and a reviser that excludes attributed roots. No LLM is called at runtime.
**Why.** The challenge is the gate, not the planner. A deterministic agent makes the eval reproducible byte for byte, costs nothing, and cannot be prompt-injected into emitting SQL. Any planner, including an LLM, can sit in front of the same gate because it only ever produces a Spec.
**Cost.** The vocabulary is two templates.

## ADR-011 — One process, one database, free tier

**Decision.** `node:http`, no framework, `pg` as the only runtime dependency, the outbox dispatcher in-process, one free Render web service plus one free Render Postgres.
**Why.** Fewer moving parts to secure and to keep alive through judging. The free plans cost nothing.
**Cost.** The free web service sleeps when idle (cold start of about a minute). Free Postgres expires 30 days after creation, so there is a continuity plan in [DEPLOY](DEPLOY.md).

## ADR-012 — Per-visitor synthetic workspaces

**Decision.** Each browser session gets its own seeded copy of the shop, isolated by query scope, composite keys and forced RLS. Reset re-seeds it.
**Why.** Visitors must be able to run destructive actions for real without affecting each other, and no real data may ever be involved.
**Cost.** Storage per workspace, bounded by the workspace cap, per-workspace history limits and the idle purge.
