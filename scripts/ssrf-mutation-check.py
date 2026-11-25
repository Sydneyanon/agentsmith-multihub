#!/usr/bin/env python3
"""Revert-proof check for the SSRF guard: each mutation re-introduces one weakness and the tests must fail.

Run from a scratch git worktree of the branch (it edits files):
  git worktree add /tmp/ssrf-wt HEAD && ln -s $PWD/node_modules /tmp/ssrf-wt/node_modules
  cd /tmp/ssrf-wt && MUTATION_WORKTREE=1 python3 scripts/ssrf-mutation-check.py
A mutation counts as killed only if the full baseline test count loads AND at least one test fails.
"""
import os, re, subprocess, sys

if os.environ.get("MUTATION_WORKTREE") != "1":
    sys.exit("refusing to edit files outside a scratch worktree (set MUTATION_WORKTREE=1)")

CMD = "npx vitest run apps/api/src/net apps/api/src/source-resolver apps/api/src/worker-runtime apps/api/src/github-research apps/api/src/acquisition/github-source 2>&1"
IP, SF, SR, GS = "apps/api/src/net/ip-policy.ts", "apps/api/src/net/safe-fetch.ts", "apps/api/src/source-resolver.ts", "apps/api/src/acquisition/github-source.ts"
WR = "apps/api/src/worker-runtime.ts"

MUTATIONS = [
  ("ip: 10/8 not blocked", IP, '["10.0.0.0", 8, "private"], ', ''),
  ("ip: link-local/metadata 169.254/16 not blocked", IP, '["169.254.0.0", 16, "link-local"], ', ''),
  ("ip: CGNAT 100.64/10 not blocked", IP, '["100.64.0.0", 10, "shared-address-space"],', ''),
  ("ip: 172.16/12 wrong width", IP, '["172.16.0.0", 12,', '["172.16.0.0", 13,'),
  ("ip: multicast/class E not blocked", IP, '["224.0.0.0", 4, "multicast"], ["240.0.0.0", 4, "reserved"],', ''),
  ("ip: IPv4-mapped IPv6 allowed", IP, 'return { public: false, reason: "ipv4-mapped" };', 'return { public: true, reason: "x" };'),
  ("ip: NAT64 allowed", IP, 'return { public: false, reason: "nat64" };', 'return { public: true, reason: "x" };'),
  ("ip: 6to4 allowed", IP, 'if (g[0] === 0x2002) return { public: false, reason: "6to4" };', ''),
  ("ip: Teredo/2001::/23 allowed", IP, 'if (g[0] === 0x2001 && g[1]! < 0x200) return { public: false, reason: "ietf-protocol-assignments/teredo" };', ''),
  ("ip: unique-local fc00::/7 allowed", IP, 'if ((g[0]! & 0xfe00) === 0xfc00) return { public: false, reason: "unique-local" };', ''),
  ("ip: link-local fe80::/10 allowed", IP, 'if ((g[0]! & 0xffc0) === 0xfe80) return { public: false, reason: "link-local" };', ''),
  ("ip: non-canonical IPv4 (leading zeros) accepted", IP, '(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})', '(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})'),
  ("host: reserved TLDs allowed", IP, 'if (BLOCKED_TLDS.has(labels[labels.length - 1]!)) return { ok: false, reason: "reserved or internal name" };', ''),
  ("host: single-label names allowed", IP, 'if (labels.length < 2) return { ok: false, reason: "single-label host" };', ''),
  ("host: numeric/hex IPv4 spellings allowed", IP, '/^(0x[0-9a-f]*|\\d+)$/i.test(labels[labels.length - 1]!) || isIP(host) !== 0', 'false'),
  ("host: bracketed/colon IP literals not recognised", IP, 'if (input.startsWith("[") || input.includes(":")) return { ok: false, reason: "IP literal" };', ''),
  ("resolver: host policy not applied", SR, 'if (!assessed.ok)', 'if (false)'),
  ("resolver: non-default ports allowed", SR, 'if (url.port !== "")', 'if (false)'),
  ("fetch: only first DNS answer checked", SF, 'for (const a of answers) {', 'for (const a of answers.slice(0, 1)) {'),
  ("fetch: peer address not verified", SF, 'if (!peer || canonicalAddress(peer) !== canonicalAddress(address))', 'if (false)'),
  ("fetch: connects by name (second resolution) instead of pinned address", SF, 'const tcp = await connectOne(address, port);', 'const tcp = await connectOne(hostname, port);'),
  ("fetch: redirect hops not revalidated", SF, 'const addresses = await validate(url);', 'const addresses = hop === 0 ? await validate(url) : ["127.0.0.1"];'),
  ("fetch: credentials kept across origins", SF, 'if (next.origin !== url.origin) for', 'if (false) for'),
  ("fetch: redirect cap removed", SF, 'if (hop >= maxRedirects) throw', 'if (false) throw'),
  ("fetch: credentials in URL allowed", SF, 'if (url.username || url.password) throw', 'if (false) throw'),
  ("fetch: port allow-list removed", SF, 'if (!allowedPorts.has(port)) throw', 'if (false) throw'),
  ("fetch: scheme check removed", SF, 'if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureHttp)) {', 'if (false) {'),
  ("fetch: loopback test policy allowed in production", SF, 'if (options.allowLoopbackForTests) assertNotProduction("allowLoopbackForTests");', ''),
  ("wiring: GitHubSource default bypasses guard", GS, 'options.fetcher ?? (options.testOrigins ? unguardedFetchForLoopbackFixtures : outboundFetch)', 'options.fetcher ?? globalThis.fetch'),
  ("wiring: worker repo lookup bypasses guard", WR, 'await outboundFetch(endpoint,', 'await fetch(endpoint,'),
  ("wiring: worker raw fetch bypasses guard", WR, 'await outboundFetch(url, {\n      method: "GET",\n      redirect: "manual",\n      headers: { "user-agent"', 'await fetch(url, {\n      method: "GET",\n      redirect: "manual",\n      headers: { "user-agent"'),
]

def run():
    r = subprocess.run(CMD, shell=True, capture_output=True, text=True, timeout=600)
    out = r.stdout
    t = re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed", out)
    failed = int(t.group(1) or 0) if t else -1
    total = (int(t.group(2)) + failed) if t else -1
    return out, failed, total

_, f0, base = run()
if f0 != 0 or base < 1: sys.exit(f"baseline not green ({f0} failing, {base} tests)")
print(f"baseline: {base} tests, all passing")
survivors = 0
for name, path, old, new in MUTATIONS:
    src = open(path).read()
    if src.count(old) != 1:
        print(f"ERROR     {name}: pattern matched {src.count(old)} times"); survivors += 1; continue
    open(path, "w").write(src.replace(old, new))
    try:
        subprocess.run("npx tsc --noEmit -p tsconfig.json >/dev/null 2>&1", shell=True)
        out, failed, total = run()
    except subprocess.TimeoutExpired:
        failed, total = 1, base
    finally:
        open(path, "w").write(src)
    killed = failed > 0 and (total == base or total == -1 and failed > 0)
    print(("KILLED   " if killed else "SURVIVED ") + name)
    survivors += 0 if killed else 1
print(f"\n{len(MUTATIONS) - survivors}/{len(MUTATIONS)} mutations killed")
sys.exit(1 if survivors else 0)
