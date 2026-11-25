#!/usr/bin/env python3
"""Generic revert-proof check. Usage (inside a scratch git worktree, MUTATION_WORKTREE=1):
  python3 scripts/mutation-check.py scripts/mutations/<spec>.json
Spec: {"command": "<test command>", "mutations": [{"name","file","old","new"}]}
A mutation is KILLED only if the same number of tests as the baseline load AND at least one fails (a suite that fails to load is not a kill)."""
import json, os, re, subprocess, sys

if os.environ.get("MUTATION_WORKTREE") != "1":
    sys.exit("refusing to edit files outside a scratch worktree (set MUTATION_WORKTREE=1)")
spec = json.load(open(sys.argv[1]))

def run():
    try:
        r = subprocess.run(spec["command"] + " 2>&1", shell=True, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return -2, -2
    t = re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed", r.stdout)
    if not t: return -1, -1
    failed = int(t.group(1) or 0)
    return failed, int(t.group(2)) + failed

f0, base = run()
if f0 != 0 or base < 1: sys.exit(f"baseline not green ({f0} failing, {base} tests)")
print(f"baseline: {base} tests, all passing")
bad = 0
for m in spec["mutations"]:
    src = open(m["file"]).read()
    if src.count(m["old"]) != 1:
        print(f"ERROR     {m['name']}: pattern matched {src.count(m['old'])} times"); bad += 1; continue
    open(m["file"], "w").write(src.replace(m["old"], m["new"]))
    try:
        failed, total = run()
    finally:
        open(m["file"], "w").write(src)
    killed = failed > 0 and (total == base or failed == -2)
    print(("KILLED   " if killed else "SURVIVED ") + m["name"])
    bad += 0 if killed else 1
n = len(spec["mutations"])
print(f"\n{n - bad}/{n} mutations killed")
sys.exit(1 if bad else 0)
