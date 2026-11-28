#!/bin/bash
# Verifies the frozen corpora against their hash manifests, and every frozen candidate against the committed registry
# (eval/candidates.json). Works in a fresh clone without tags; tags, when present locally, must agree with the registry.
set -euo pipefail
cd "$(dirname "$0")"
for c in heldout heldout2 heldout3 heldout4; do (cd $c && sha256sum -c MANIFEST.sha256 --quiet && echo "$c: manifest OK ($(cat MANIFEST.sha256.sum | cut -c1-16)...)"); done
# benchmark-b: current version, plus every archived version's files must still be byte-identical (amendments add, never alter)
(cd benchmark-b && sha256sum -c MANIFEST.sha256 --quiet && [ "$(sha256sum MANIFEST.sha256 | cut -c1-64)" = "$(cat MANIFEST.sha256.sum)" ] \
  && echo "benchmark-b v$(sed -n 's/^  "version": \([0-9]*\),$/\1/p' BENCHMARK.json): manifest OK ($(cut -c1-16 MANIFEST.sha256.sum)...)")
for v in benchmark-b/versions/v*/; do
  while read -r hash rel; do
    f="benchmark-b/$rel"; [ "$rel" = labels.json ] && f="${v}labels.json"
    [ "$(sha256sum "$f" | cut -c1-64)" = "$hash" ] || { echo "benchmark-b $(basename "$v"): $rel ALTERED"; exit 1; }
  done < "${v}MANIFEST.sha256"
  echo "benchmark-b $(basename "$v"): archived version intact"
done
sha256sum -c LABELS.sha256 --quiet && echo "labels and answer keys: OK ($(grep -vc '^#' LABELS.sha256) files)"
./candidates.sh verify
