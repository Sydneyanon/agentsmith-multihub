#!/usr/bin/env bash
# One build-only run of the FROZEN release candidate, for a trusted machine or hosted shell with normal internet and a Fly login.
# It builds and pushes ONE image tag and nothing else: no deploy, no restart, no secrets, no DNS, no database. It does not use the
# legacy builder, does not edit the Dockerfile, and does not disable TLS verification.
#
#   fly auth login            # or: export FLY_API_TOKEN=...   (never paste a token into chat)
#   bash release-build-external.sh
#   DRY_RUN=1 bash release-build-external.sh      # prints what it would do, builds nothing
#
# Paste everything printed between the two ==== lines back to Claude.
set -euo pipefail
SHA="7eed70f6c7f304bb9df5bc213783b588a1b6b7bc"          # the frozen release candidate; the script refuses anything else
LABEL="rc-${SHA:0:12}"
APP="agentsmith-hub"
REPO_URL="${REPO_URL:-https://github.com/Sydneyanon/agentsmith-multihub.git}"
DRY="${DRY_RUN:-0}"
FLY="$(command -v fly || command -v flyctl || true)"
[ -n "$FLY" ] || { echo "flyctl not found. Install it first: https://fly.io/docs/flyctl/install/"; exit 1; }
for c in git curl python3; do command -v "$c" >/dev/null || { echo "$c is required"; exit 1; }; done
"$FLY" auth whoami >/dev/null 2>&1 || { echo "Not logged in to Fly: run 'fly auth login' (or export FLY_API_TOKEN) first."; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
echo "== fetching the exact commit"
git clone --quiet "$REPO_URL" "$W/clone"
git -C "$W/clone" checkout --quiet --detach "$SHA"
GOT="$(git -C "$W/clone" rev-parse HEAD)"
[ "$GOT" = "$SHA" ] || { echo "REFUSING: checked-out commit $GOT is not the frozen candidate $SHA"; exit 1; }
mkdir "$W/src"; git -C "$W/clone" archive "$SHA" | tar -x -C "$W/src"
FILES="$(find "$W/src" -type f | wc -l | tr -d ' ')"
DOCKERFILE_SHA="$(sha256sum "$W/src/Dockerfile" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$W/src/Dockerfile" | cut -d' ' -f1)"

state() { # read-only production snapshot: machines (id, state, image), release count. Fails loudly if it cannot read them.
  local out
  out="$("$FLY" status --app "$APP" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
ms = d.get('Machines') or []
if not ms: sys.exit('no machines found in status output')
print('version', d.get('Version'), '|', '; '.join('{} {} {}'.format(m['id'], m['state'], m['config'].get('image')) for m in ms))
")" || { echo "could not read production status" >&2; return 1; }
  echo "$out"
  echo "releases $("$FLY" releases --app "$APP" --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
}
echo "== production BEFORE (read-only)"; BEFORE="$(state)"; echo "$BEFORE"

CMD=("$FLY" deploy --build-only --push --image-label "$LABEL" --app "$APP" --config fly.hub.toml --remote-only)
echo "== running: ${CMD[*]}"
if [ "$DRY" = 1 ]; then echo "(dry run: not executed)"; else (cd "$W/src" && FLY_NO_UPDATE_CHECK=1 "${CMD[@]}") 2>&1 | tee "$W/build.log"; fi

DIGEST="(dry run)"
if [ "$DRY" != 1 ]; then
  TOKEN="$("$FLY" auth token)"
  DIGEST="$(curl -fsSI -u "x:$TOKEN" -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' "https://registry.fly.io/v2/$APP/manifests/$LABEL" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')"
  unset TOKEN
  [ -n "$DIGEST" ] || { echo "Could not read the pushed digest"; exit 1; }
fi
echo "== production AFTER (read-only)"; AFTER="$(state)"; echo "$AFTER"
# A stopped machine may wake on a visitor's request; only the image and the release count must be unchanged.
norm() { echo "$1" | sed -E 's/ (started|stopped|starting|stopping|suspended) / STATE /g'; }
if [ "$(norm "$BEFORE")" = "$(norm "$AFTER")" ]; then CHANGED="no (image and release count unchanged)"; else CHANGED="YES - INVESTIGATE BEFORE ANYTHING ELSE"; fi

echo
echo "==== PASTE THIS BACK TO CLAUDE ===="
echo "frozen commit : $SHA (verified checkout: $GOT)"
echo "files in build context: $FILES   Dockerfile sha256: $DOCKERFILE_SHA"
echo "image label   : $LABEL"
echo "registry ref  : registry.fly.io/$APP:$LABEL"
echo "image digest  : $DIGEST"
echo "production before: $BEFORE"
echo "production after : $AFTER"
echo "production changed: $CHANGED"
echo "==== END ===="
