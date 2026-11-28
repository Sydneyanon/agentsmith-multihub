#!/bin/bash
# Usage: eval/ground-truth/run-all.sh <scratch dir with node_modules>   (see package.json; install with `npm install --ignore-scripts`)
# Runs the compiler-backed experiments inside a network namespace with NO network (unshare -rn) when available.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SCR="${1:?scratch dir with node_modules}"
cp "$HERE"/*.mjs "$HERE"/Attacker.sol "$SCR"/; mkdir -p "$SCR/counterfactual"; cp "$HERE"/counterfactual/*.sol "$SCR/counterfactual/"; cp "$HERE"/specs-*.json "$SCR"/
ln -sfn "$HERE/../heldout" "$SCR/../heldout"; ln -sfn "$HERE/../dev" "$SCR/../dev"
cd "$SCR"
run() { if unshare -rn true 2>/dev/null; then unshare -rn node "$@"; else echo "WARNING: could not create a network namespace; running without it" >&2; node "$@"; fi; }
run compile-corpus.mjs "$HERE/../heldout/contracts"
run run-reentrancy.mjs specs-reentrancy.json "$HERE/../results/ground-truth-reentrancy.json"
run run-reentrancy.mjs specs-counterfactual.json "$HERE/../results/ground-truth-counterfactual.json"
