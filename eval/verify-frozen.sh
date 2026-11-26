#!/bin/bash
# Verifies the frozen corpora against their hash manifests and that the candidate tag still points at the recorded commit.
set -euo pipefail
cd "$(dirname "$0")"
for c in heldout heldout2 heldout3; do (cd $c && sha256sum -c MANIFEST.sha256 --quiet && echo "$c: manifest OK ($(cat MANIFEST.sha256.sum | cut -c1-16)...)"); done
want=6cd3be7573b80e995eabffd12e218807a2100f27; got=$(git rev-parse structural-candidate-1^{commit} 2>/dev/null || echo missing)
[ "$got" = "$want" ] && echo "candidate tag structural-candidate-1: OK ($got)" || { echo "candidate tag mismatch: $got" >&2; exit 1; }
want2=9c2d80e70eb08dae2afae5ab55a11e372c38061d; got2=$(git rev-parse structural-candidate-2^{commit} 2>/dev/null || echo missing)
[ "$got2" = "$want2" ] && echo "candidate tag structural-candidate-2: OK ($got2)" || { echo "candidate tag mismatch: $got2" >&2; exit 1; }
