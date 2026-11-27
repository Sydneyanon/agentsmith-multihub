#!/bin/bash
# Verifies the frozen corpora against their hash manifests, and every frozen candidate against the committed registry
# (eval/candidates.json). Works in a fresh clone without tags; tags, when present locally, must agree with the registry.
set -euo pipefail
cd "$(dirname "$0")"
for c in heldout heldout2 heldout3 heldout4; do (cd $c && sha256sum -c MANIFEST.sha256 --quiet && echo "$c: manifest OK ($(cat MANIFEST.sha256.sum | cut -c1-16)...)"); done
sha256sum -c LABELS.sha256 --quiet && echo "labels and answer keys: OK ($(grep -vc '^#' LABELS.sha256) files)"
./candidates.sh verify
