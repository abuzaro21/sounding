#!/usr/bin/env bash
# Build the production image, run it against a throwaway PostgreSQL on a private network, and drive one gate cycle over HTTP.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
docker build -t sounding:ci "$here"
docker rm -f snd-ci-app snd-ci-db >/dev/null 2>&1 || true
docker network rm snd-ci >/dev/null 2>&1 || true
docker network create snd-ci >/dev/null
cleanup() { docker logs snd-ci-app 2>&1 | tail -20 || true; docker rm -f snd-ci-app snd-ci-db >/dev/null 2>&1 || true; docker network rm snd-ci >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name snd-ci-db --network snd-ci -e POSTGRES_PASSWORD=devonly postgres:16-alpine >/dev/null
# Wait for the final server (not the entrypoint's temporary one), then create the app role and databases.
for _ in $(seq 1 60); do docker exec snd-ci-db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec -i snd-ci-db psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q < "$here/scripts/db-init.sql"
docker run -d --name snd-ci-app --network snd-ci -p 3399:3000 -e DATABASE_URL=postgres://app:app@snd-ci-db:5432/sim sounding:ci >/dev/null
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3399/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3399/healthz | grep -q '"rls_enforced":true'
curl -sf http://127.0.0.1:3399/ | grep -q '<div id="root">'
node "$here/scripts/live-check.ts" http://127.0.0.1:3399
echo "docker smoke ok"
