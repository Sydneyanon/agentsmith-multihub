#!/usr/bin/env bash
# Builds the production image WITHOUT Docker, for sessions that cannot reach Fly's remote builder.
# It reproduces the existing Dockerfile (build stage, then runtime stage) by hand and appends the result to the pinned
# node:22-alpine linux/amd64 base with `crane` (a daemonless registry client). See docs/hub-production-plan.md section 13.
#
#   scripts/hub-image.sh build    build stage + runtime layer from the committed code (git archive HEAD), no network except npm
#   scripts/hub-image.sh verify   unpack base + layer into a root filesystem, chroot as the `node` user, run the production smoke tests
#   scripts/hub-image.sh push     assemble and push registry.fly.io/<app>:<tag>, then check the pushed image against the tested layer
#
# Requires: node 22, npm, git, crane, python3, and (verify) root, a loopback Postgres in TEST_DATABASE_URL.
# `push` needs FLY_API_TOKEN in the environment; it is passed to crane over stdin into a throw-away config dir and never printed.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORK="${HUB_IMAGE_WORK:-/tmp/hub-image-work}"
APP="${HUB_IMAGE_APP:-agentsmith-hub}"
BASE_REF="${HUB_IMAGE_BASE:-node:22-alpine}"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHORT="${SHA:0:12}"
TAG="${HUB_IMAGE_TAG:-hub-$SHORT}"
SDE="$(git -C "$ROOT" log -1 --format=%ct HEAD)"   # fixed file times: same commit, same layer bytes
# The last migration APPROVED FOR THIS RELEASE (e.g. 0007). Later migration files, and every draft under db/drafts, are left out of the
# image, so an unapproved migration can never be applied from it (the runner applies every file it ships). Required: no silent default.
RELEASE_LAST_MIGRATION="${HUB_RELEASE_LAST_MIGRATION:-}"

base_digest() { # digest of the linux/amd64 manifest inside the base image index
  crane manifest "$BASE_REF" | python3 -c '
import sys, json
for m in json.load(sys.stdin)["manifests"]:
    p = m.get("platform", {})
    if p.get("os") == "linux" and p.get("architecture") == "amd64" and "variant" not in p: print(m["digest"]); break
else: sys.exit("no linux/amd64 manifest in the base image")'
}

build() {
  [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { echo "refusing to build: tracked files have uncommitted changes (the image must be exactly commit $SHORT)"; exit 1; }
  rm -rf "$WORK/stage1" "$WORK/stage2" "$WORK/app.tar" "$WORK/app.tar.gz"
  mkdir -p "$WORK/stage1" "$WORK/stage2/app"
  # Dockerfile build stage: COPY package*.json, tsconfig.json, apps, scripts, db; npm ci; npm run build
  git -C "$ROOT" archive HEAD package.json package-lock.json tsconfig.json tsconfig.build.json apps scripts db | tar -x -C "$WORK/stage1"
  (cd "$WORK/stage1" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  [[ "$RELEASE_LAST_MIGRATION" =~ ^[0-9]{4}$ ]] || { echo "set HUB_RELEASE_LAST_MIGRATION to the last migration approved for this release (e.g. 0007)"; exit 1; }
  local excluded=""
  for f in "$WORK/stage1/db/migrations/"*.sql; do n="$(basename "$f")"; if [ "${n%%_*}" \> "$RELEASE_LAST_MIGRATION" ]; then excluded="$excluded $n"; rm "$f"; fi; done
  rm -rf "$WORK/stage1/db/drafts"
  ls "$WORK/stage1/db/migrations/${RELEASE_LAST_MIGRATION}_"*.sql >/dev/null 2>&1 || { echo "migration $RELEASE_LAST_MIGRATION not found"; exit 1; }
  local shipped; shipped="$(cd "$WORK/stage1/db/migrations" && ls *.sql | sed 's/.*/"&"/' | paste -sd, -)"
  local excl_json; excl_json="$(for n in $excluded; do printf '"%s"\n' "$n"; done | paste -sd, -)"
  # build identity for GET /v1/engine/status (commit, image tag, commit time: deterministic, so two builds stay byte-identical)
  printf '{"commit":"%s","image":"registry.fly.io/%s:%s","built_at":"%s","migrations_shipped":[%s],"migrations_excluded":[%s]}\n' "$SHA" "$APP" "$TAG" "$(date -u -d "@$SDE" +%Y-%m-%dT%H:%M:%SZ)" "$shipped" "$excl_json" > "$WORK/stage1/dist/build-info.json"
  echo "migrations shipped: $shipped; excluded (not approved for this release):${excluded:- none}; drafts removed"
  # Dockerfile runtime stage: COPY package*.json; npm ci --omit=dev; COPY dist, db
  cp "$WORK/stage1/package.json" "$WORK/stage1/package-lock.json" "$WORK/stage2/app/"
  (cd "$WORK/stage2/app" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
  cp -r "$WORK/stage1/dist" "$WORK/stage1/db" "$WORK/stage2/app/"
  find "$WORK/stage2" -exec touch -h -d "@$SDE" {} +
  tar --sort=name --format=gnu --owner=0 --group=0 --numeric-owner -C "$WORK/stage2" -cf "$WORK/app.tar" app
  gzip -n -9 -c "$WORK/app.tar" > "$WORK/app.tar.gz"
  sha256sum "$WORK/app.tar" | cut -d' ' -f1 > "$WORK/layer.diffid"
  echo "built layer for commit $SHA"
  echo "  uncompressed layer sha256 (diff_id): $(cat "$WORK/layer.diffid")"
  echo "  files: $(tar -tf "$WORK/app.tar" | wc -l), size: $(du -h "$WORK/app.tar.gz" | cut -f1) compressed"
}

verify() {
  [ "$(id -u)" = 0 ] || { echo "verify needs root (chroot)"; exit 1; }
  [ -f "$WORK/app.tar" ] || { echo "run build first"; exit 1; }
  local digest; digest="$(base_digest)"; echo "base $BASE_REF linux/amd64 manifest: $digest"
  rm -rf "$WORK/base-oci" "$WORK/rootfs"; mkdir -p "$WORK/rootfs"
  crane pull --platform linux/amd64 --format oci "${BASE_REF%%:*}@$digest" "$WORK/base-oci" 2>&1 | tail -1 || true
  python3 - "$WORK" <<'PY'
import json, os, subprocess, sys
w = sys.argv[1]; oci = w + "/base-oci"
idx = json.load(open(oci + "/index.json")); mf = idx["manifests"][0]["digest"].split(":")[1]
m = json.load(open(f"{oci}/blobs/sha256/{mf}"))
for layer in m["layers"]:
    subprocess.check_call(["tar", "-xf", f'{oci}/blobs/sha256/{layer["digest"].split(":")[1]}', "-C", w + "/rootfs"])
print("base layers applied:", len(m["layers"]))
PY
  tar -xf "$WORK/app.tar" -C "$WORK/rootfs"
  for n in "null c 1 3" "zero c 1 5" "random c 1 8" "urandom c 1 9"; do set -- $n; [ -e "$WORK/rootfs/dev/$1" ] || mknod -m 666 "$WORK/rootfs/dev/$1" "$2" "$3" "$4"; done
  "$ROOT/scripts/hub-image-smoke.sh" "$WORK/rootfs" "$ROOT"
}

push() {
  [ -n "${FLY_API_TOKEN:-}" ] || { echo "FLY_API_TOKEN is not set"; exit 1; }
  [ -f "$WORK/app.tar.gz" ] || { echo "run build first"; exit 1; }
  local digest; digest="$(base_digest)"
  export DOCKER_CONFIG; DOCKER_CONFIG="$(mktemp -d)"; chmod 700 "$DOCKER_CONFIG"; trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  printf '%s' "$FLY_API_TOKEN" | crane auth login registry.fly.io -u x --password-stdin >/dev/null
  local ref="registry.fly.io/$APP:$TAG"
  # Base layers + our one layer; the Dockerfile's runtime settings; the base image's entrypoint is kept.
  crane mutate "${BASE_REF%%:*}@$digest" --platform linux/amd64 --append "$WORK/app.tar.gz" \
    -e NODE_ENV=production -w /app -u node --cmd npm,start --exposed-ports 8080/tcp \
    -l "org.opencontainers.image.revision=$SHA" -l "org.opencontainers.image.base.digest=$digest" -t "$ref"
  echo "pushed $ref"
  crane digest "$ref"
  # Check what was pushed against what was tested.
  crane config "$ref" > "$WORK/pushed-config.json"
  python3 - "$WORK/pushed-config.json" "$WORK/layer.diffid" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); want = open(sys.argv[2]).read().strip()
ids = c["rootfs"]["diff_ids"]; cfg = c["config"]
checks = {
  "architecture is amd64": c["architecture"] == "amd64", "os is linux": c["os"] == "linux",
  "last layer is the tested layer": ids[-1] == "sha256:" + want, "base layers + 1": len(ids) == 5,
  "user node": cfg.get("User") == "node", "workdir /app": cfg.get("WorkingDir") == "/app",
  "cmd npm start": cfg.get("Cmd") == ["npm", "start"], "entrypoint kept": cfg.get("Entrypoint") == ["docker-entrypoint.sh"],
  "NODE_ENV=production": "NODE_ENV=production" in cfg.get("Env", []), "port 8080": "8080/tcp" in cfg.get("ExposedPorts", {}),
}
bad = [k for k, v in checks.items() if not v]
for k, v in checks.items(): print(("PASS " if v else "FAIL ") + k)
sys.exit(1 if bad else 0)
PY
}

case "${1:-}" in build) build ;; verify) verify ;; push) push ;; *) echo "usage: $0 build|verify|push"; exit 2 ;; esac
