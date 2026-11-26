#!/usr/bin/env bash
# Production smoke test of the real image filesystem: chroot into <rootfs> (Alpine + musl Node + the app layer) as the `node` user and
# start it exactly as the image does (ENTRYPOINT docker-entrypoint.sh, CMD npm start, WORKDIR /app, NODE_ENV=production).
# Uses a disposable database on the LOOPBACK Postgres in TEST_DATABASE_URL and drops it afterwards. Exits non-zero on any failure.
# Production mode connects to Postgres with TLS and certificate verification ON, and this test keeps it on: the loopback Postgres must have
# TLS enabled with a throw-away CA (certificate for IP 127.0.0.1), and HUB_SMOKE_DB_CA must point at that CA certificate. The CA is made
# known to the image's Node through NODE_EXTRA_CA_CERTS only, never by disabling verification.
set -uo pipefail
ROOTFS="$1"; REPO="$2"
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL (loopback Postgres) is required}"
: "${HUB_SMOKE_DB_CA:?HUB_SMOKE_DB_CA (CA certificate of the loopback Postgres TLS) is required: production mode verifies database TLS}"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

PORT=18083; HOSTN=hub.agentsmithdesk.xyz
TOKEN="$(head -c 36 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
DB="hubimg_$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ADMIN="$TEST_DATABASE_URL"; case "$ADMIN" in postgres://*@127.0.0.1:*|postgres://*@localhost:*) ;; *) echo "TEST_DATABASE_URL must be loopback"; exit 2 ;; esac
DBURL="${ADMIN%/*}/$DB"
psql "$ADMIN" -qc "CREATE DATABASE $DB" || { echo "cannot create disposable database"; exit 2; }
cleanup() { pkill -f "dist/apps/api/src/server.js" 2>/dev/null; sleep 1; psql "$ADMIN" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1; }
trap cleanup EXIT

UID_NODE="$(awk -F: '$1=="node"{print $3":"$4}' "$ROOTFS/etc/passwd")"
run_in() { # run in the image as the node user with a clean environment, WORKDIR /app
  chroot --userspec="$UID_NODE" "$ROOTFS" /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/node NODE_ENV=production "$@"
}

mkdir -p "$ROOTFS/tmp" && cp "$HUB_SMOKE_DB_CA" "$ROOTFS/tmp/hub-smoke-ca.crt" && chmod 644 "$ROOTFS/tmp/hub-smoke-ca.crt"
CA_ENV="NODE_EXTRA_CA_CERTS=/tmp/hub-smoke-ca.crt"

echo "== image filesystem"
check "node user exists and is not root (uid:gid $UID_NODE)" '[ -n "$UID_NODE" ] && [ "${UID_NODE%%:*}" != 0 ]'
check "musl dynamic loader present (Alpine runtime)" '[ -e "$ROOTFS/lib/ld-musl-x86_64.so.1" ]'
check "node binary is an x86-64 ELF" 'python3 - "$ROOTFS/usr/local/bin/node" <<PY
import sys; h=open(sys.argv[1],"rb").read(20); sys.exit(0 if h[:4]==b"\x7fELF" and int.from_bytes(h[18:20],"little")==62 else 1)
PY'
echo "     node in image: $(run_in node -v 2>&1) (host: $(node -v))"
check "node in image runs" 'run_in node -e "process.exit(0)"'
check "app files are root-owned and not writable by node" '! run_in sh -c "touch /app/probe" 2>/dev/null && ! run_in sh -c "touch /app/dist/probe" 2>/dev/null'
check "only production dependencies were installed (no typescript, vitest, jsdom, playwright-core)" '[ ! -e "$ROOTFS/app/node_modules/typescript" ] && [ ! -e "$ROOTFS/app/node_modules/vitest" ] && [ ! -e "$ROOTFS/app/node_modules/jsdom" ] && [ ! -e "$ROOTFS/app/node_modules/playwright-core" ]'
check "hub client and migrations are in the image" '[ -f "$ROOTFS/app/dist/web/index.html" ] && [ -f "$ROOTFS/app/dist/web/assets/main.js" ] && [ "$(ls "$ROOTFS"/app/db/migrations/*.sql | wc -l)" = 8 ]'
check "no tests, fixtures, test harnesses, declaration files, source maps or dev scripts in dist" '[ -z "$(find "$ROOTFS/app/dist" \( -name "*.test.js" -o -name "*.spec.js" -o -name "*.d.ts" -o -name "*.map" -o -path "*/integration/*" -o -path "*/testing/*" -o -name "hub-demo.js" -o -name "hub-layout-check.js" -o -name "hub-screenshots.js" \) | head -1)" ] && [ -f "$ROOTFS/app/dist/apps/api/src/server.js" ] && [ -f "$ROOTFS/app/dist/scripts/migrate.js" ]'
check "no secret or local-state files in the image" '[ -z "$(find "$ROOTFS/app" -maxdepth 2 \( -name ".env*" -o -name ".git" -o -name "*.pem" \) | head -1)" ]'

echo "== weak token is refused at startup"
OUT="$(run_in sh -c 'cd /app && API_BEARER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa PORT=18084 timeout 8 docker-entrypoint.sh npm start' 2>&1)"; RC=$?
check "server exits non-zero on a repetitive token (rc=$RC)" '[ "$RC" != 0 ] && echo "$OUT" | grep -q "API_BEARER_TOKEN"'

echo "== database TLS verification stays ON in production mode"
OUT="$(run_in sh -c "cd /app && DIRECT_DATABASE_URL='$DBURL' node dist/scripts/migrate.js" 2>&1)"; RC=$?
check "a database certificate from an unknown CA is refused (rc=$RC)" '[ "$RC" != 0 ] && echo "$OUT" | grep -qiE "self-signed|unable to verify|certificate"'
check "nothing was migrated by the refused connection" '[ -z "$(psql "$DBURL" -Atc "select 1 from information_schema.tables where table_name='"'"'schema_migrations'"'"'")" ]'

echo "== migration inside the image, against a disposable loopback database (TLS verified with the throw-away CA)"
OUT="$(run_in sh -c "cd /app && $CA_ENV DIRECT_DATABASE_URL='$DBURL' node dist/scripts/migrate.js" 2>&1)"; RC=$?
check "migrate.js exits 0 (rc=$RC)" '[ "$RC" = 0 ]'
check "all eight migrations recorded in schema_migrations" '[ "$(psql "$DBURL" -Atc "select count(*) from schema_migrations")" = 8 ]'
check "research-state tables exist" '[ -n "$(psql "$DBURL" -Atc "select 1 from information_schema.tables where table_name='"'"'repo_snapshots'"'"'")" ]'
echo "$OUT" | tail -3 | sed 's/^/     /'

echo "== start exactly as the image does"
( run_in sh -c "cd /app && HOST=127.0.0.1 PORT=$PORT LOG_LEVEL=info DATABASE_CONNECT_TIMEOUT_MS=30000 $CA_ENV DATABASE_URL='$DBURL' HUB_ALLOWED_HOSTS=$HOSTN API_BEARER_TOKEN='$TOKEN' exec docker-entrypoint.sh npm start" >/tmp/hubimg.log 2>&1 & )
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/health/live" && break; sleep 1; done
# Only the node user's process: an unrelated process whose command line merely contains the path (a wrapper, another run) must not be mistaken for the server.
PID="$(pgrep -u "${UID_NODE%%:*}" -f '^node dist/apps/api/src/server.js' | head -1)"
check "server process runs as the node user, not root (uid $(ps -o uid= -p "${PID:-0}" 2>/dev/null | tr -d ' '))" '[ -n "$PID" ] && [ "$(ps -o uid= -p "$PID" | tr -d " ")" = "${UID_NODE%%:*}" ]'
H() { curl -s -o /dev/null -w "%{http_code}" -H "Host: $1" "http://127.0.0.1:$PORT$2" "${@:3}"; }
check "GET /health/live -> 200" '[ "$(H 10.0.0.9:8080 /health/live)" = 200 ]'
check "GET /health/ready -> 200 (database reachable)" '[ "$(H 10.0.0.9:8080 /health/ready)" = 200 ]'
check "GET /hub/ on the hub hostname -> 200" '[ "$(H $HOSTN /hub/)" = 200 ]'
check "GET / on the hub hostname redirects to /hub/ and reveals no service name or version" '[ "$(H $HOSTN /)" = 302 ] && curl -s -D - -o /tmp/hubimg.root -H "Host: $HOSTN" "http://127.0.0.1:$PORT/" | grep -qi "^location: /hub/" && ! grep -qiE "service|version|scaffold" /tmp/hubimg.root'
check "GET /hub/assets/main.js and styles.css -> 200" '[ "$(H $HOSTN /hub/assets/main.js)" = 200 ] && [ "$(H $HOSTN /hub/assets/styles.css)" = 200 ]'
HDRS="$(curl -s -D - -o /dev/null -H "Host: $HOSTN" "http://127.0.0.1:$PORT/hub/")"
check "CSP is the strict policy (no unsafe-inline / unsafe-eval)" 'echo "$HDRS" | grep -i "^content-security-policy:" | grep -q "default-src .none." && ! echo "$HDRS" | grep -i "^content-security-policy:" | grep -qiE "unsafe-(inline|eval)"'
check "HSTS present, without includeSubDomains" 'echo "$HDRS" | grep -i "^strict-transport-security:" | grep -q "max-age=31536000" && ! echo "$HDRS" | grep -i "^strict-transport-security:" | grep -qi includeSubDomains'
check "nosniff and no-referrer present" 'echo "$HDRS" | grep -qi "^x-content-type-options: nosniff" && echo "$HDRS" | grep -qi "^referrer-policy: no-referrer"'
check "other hostnames (hunt, fly.dev) -> 421" '[ "$(H hunt.agentsmithdesk.xyz /hub/)" = 421 ] && [ "$(H agentsmith-hub.fly.dev /hub/)" = 421 ] && [ "$(H hunt.agentsmithdesk.xyz /v1/research/overview)" = 421 ]'
check "/v1/research/overview without token -> 401" '[ "$(H $HOSTN /v1/research/overview)" = 401 ]'
check "/v1/research/overview with the token -> 200 with real database" '[ "$(H $HOSTN /v1/research/overview -H "Authorization: Bearer $TOKEN")" = 200 ]'
check "research data is empty on a fresh database (no seeded records)" '[ "$(curl -s -H "Host: $HOSTN" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/research/overview" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[\"projects\"][\"total\"]+d[\"research\"][\"hypotheses\"][\"total\"])")" = 0 ]'
for i in $(seq 1 11); do H $HOSTN /v1/research/overview -H "Authorization: Bearer wrong" >/dev/null; done
check "repeated wrong tokens are throttled (429)" '[ "$(H $HOSTN /v1/research/overview -H "Authorization: Bearer wrong")" = 429 ]'
check "...but the valid operator token is never locked out (200)" '[ "$(H $HOSTN /v1/research/overview -H "Authorization: Bearer $TOKEN")" = 200 ]'
check "token never appears in the server log" '! grep -q "$TOKEN" /tmp/hubimg.log'

echo; echo "image smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
