#!/usr/bin/env bash
# One CI definition for GitHub Actions and the local clean-clone run.
# Expects: Node 24.13 and PostgreSQL 16 on 127.0.0.1:55432 with scripts/db-init.sql applied (npm run db:up does both locally).
set -euo pipefail
step() { echo; echo "=== $1 ($(date -u +%H:%M:%S))"; }

step "node $(node --version)"
step "install";            npm ci && npx playwright install --with-deps chromium
step "typecheck";          npm run typecheck
step "build";              npm run build
step "unit + integration + HTTP + property tests"; npm test
step "evaluation (must reproduce the committed numbers)"
npm run eval
git diff --exit-code -- docs/evidence/eval.json
step "browser tests (desktop + mobile)"; npx playwright test
step "audit";              npm audit --audit-level=high
if command -v docker >/dev/null; then
  step "docker build + smoke"; bash scripts/docker-smoke.sh
else
  step "docker build + smoke: SKIPPED (no docker in this environment)"
fi
step "CI PASSED"
