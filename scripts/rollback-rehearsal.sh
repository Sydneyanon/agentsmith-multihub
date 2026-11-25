#!/usr/bin/env bash
# Local rollback rehearsal (disposable loopback database only; nothing remote is touched).
# Proves that the PREVIOUS release's code still serves a database that the NEW release migrated and whose runtime role was restricted:
#   1. migrate a fresh DB with the new code, create a runtime role and apply db/runtime-grants.json
#   2. start the NEW build as the restricted role; read, write an intake
#   3. stop it; start the OLD build (path in OLD_BUILD_DIR, a checkout of the previous release commit with `npm run build` done) on the same DB,
#      first as the restricted role, then as the owner (the pre-change configuration); read, see the new build's data, write an intake
# Usage: TEST_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/postgres OLD_BUILD_DIR=/path/to/old/checkout scripts/rollback-rehearsal.sh
set -uo pipefail
: "${TEST_DATABASE_URL:?loopback TEST_DATABASE_URL required}"; : "${OLD_BUILD_DIR:?OLD_BUILD_DIR required}"
case "$TEST_DATABASE_URL" in postgres://*@127.0.0.1:*|postgres://*@localhost:*) ;; *) echo "TEST_DATABASE_URL must be loopback"; exit 2 ;; esac
cd "$(git rev-parse --show-toplevel)"
SUF="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"; DB="agentsmith_test_rb$SUF"; ROLE="rt_rb$SUF"; RPW="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TOKEN="$(head -c 36 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
BASE="${TEST_DATABASE_URL%/*}"; OWNER_URL="$BASE/$DB"; RT_URL="postgres://$ROLE:$RPW@${BASE#*@}/$DB"
PASS=0; FAIL=0; ok() { PASS=$((PASS+1)); echo "PASS  $1"; }; bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cleanup() { pkill -f "rb-rehearsal-server" 2>/dev/null; sleep 1; psql "$TEST_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" 2>/dev/null; psql "$TEST_DATABASE_URL" -qc "DROP ROLE IF EXISTS $ROLE" 2>/dev/null; }
trap cleanup EXIT
psql "$TEST_DATABASE_URL" -qc "CREATE DATABASE $DB" || exit 2
DIRECT_DATABASE_URL="$OWNER_URL" npx tsx scripts/migrate.ts >/dev/null 2>&1 || { echo "migrate failed"; exit 2; }
psql "$TEST_DATABASE_URL" -qc "CREATE ROLE $ROLE LOGIN PASSWORD '$RPW' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" -c "GRANT CONNECT ON DATABASE $DB TO $ROLE" || exit 2
DIRECT_DATABASE_URL="$OWNER_URL" RUNTIME_ROLE="$ROLE" npx tsx scripts/apply-runtime-grants.ts >/dev/null 2>&1 || { echo "grants failed"; exit 2; }

serve() { # $1 build dir, $2 database url, $3 port
  (cd "$1" && exec -a rb-rehearsal-server env HOST=127.0.0.1 PORT="$3" DATABASE_URL="$2" API_BEARER_TOKEN="$TOKEN" LOG_LEVEL=error node dist/apps/api/src/server.js) >/tmp/rb-$3.log 2>&1 &
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$3/health/live" && return 0; sleep 0.25; done; return 1
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
exercise() { # $1 label $2 port $3 expected-run-count-at-least
  local P=$2 A="Authorization: Bearer $TOKEN" MIN=$3
  check "$1: /health/ready is 200 (database reachable)" '[ "$(code http://127.0.0.1:$P/health/ready)" = 200 ]'
  check "$1: dashboard shell is served" '[ "$(code http://127.0.0.1:$P/hub/)" = 200 ]'
  check "$1: API without a token is 401" '[ "$(code http://127.0.0.1:$P/v1/research/overview)" = 401 ]'
  check "$1: API with the token is 200" '[ "$(code -H "$A" http://127.0.0.1:$P/v1/research/overview)" = 200 ]'
  check "$1: an intake is accepted" '[ "$(code -X POST -H "$A" -H "content-type: application/json" -d "{\"kind\":\"idea\",\"value\":\"rehearsal idea $1 $RANDOM\"}" http://127.0.0.1:$P/v1/intake)" = 202 ] || [ "$(code -X POST -H "$A" -H "content-type: application/json" -d "{\"kind\":\"idea\",\"value\":\"rehearsal idea again $1 $RANDOM\"}" http://127.0.0.1:$P/v1/intake)" = 201 ]'
  check "$1: workflow list readable and holds at least $3 run(s)" '[ "$(curl -s -H "$A" http://127.0.0.1:$P/v1/workflows | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get(\"workflows\", d.get(\"items\", d)) if isinstance(d, dict) else d))")" -ge $MIN ]'
}
echo "== NEW build, restricted role"; serve "$PWD" "$RT_URL" 18101 && exercise new-restricted 18101 1 || bad "new build did not start"
pkill -f rb-rehearsal-server; sleep 1
echo "== OLD build (previous release), restricted role"; serve "$OLD_BUILD_DIR" "$RT_URL" 18102 && exercise old-restricted 18102 2 || bad "old build did not start as the restricted role"
pkill -f rb-rehearsal-server; sleep 1
echo "== OLD build, owner role (the pre-change configuration: rollback of DATABASE_URL as well)"; serve "$OLD_BUILD_DIR" "$OWNER_URL" 18103 && exercise old-owner 18103 3 || bad "old build did not start as the owner"
echo; echo "rollback rehearsal: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]
