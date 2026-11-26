// BASELINE PROTOTYPE (frozen). The first, line-pattern analyzer written for the Track B demonstration, extracted unchanged apart from
// the export below. Kept so every later analyzer is measured against it on the same corpora. Not a product component.
type Fn = { contract: string; name: string; visibility: string; mutability: string; modifiers: string[]; start: number; end: number; lines: string[] };

function parseFunctions(path: string, text: string): Fn[] {
  const lines = text.split("\n");
  const fns: Fn[] = [];
  let contract = "?";
  for (let i = 0; i < lines.length; i++) {
    const c = /^\s*contract\s+([A-Za-z_]\w*)/.exec(lines[i]!);
    if (c) contract = c[1]!;
    const f = /^\s*(function|modifier)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)([^{]*)\{/.exec(lines[i]!);
    if (!f) continue;
    let depth = 0; let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      if (depth === 0) { end = j; break; }
    }
    const tail = f[4]!;
    const vis = /\b(external|public|internal|private)\b/.exec(tail)?.[1] ?? (f[1] === "modifier" ? "modifier" : "public");
    const mut = /\b(view|pure|payable)\b/.exec(tail)?.[1] ?? "nonpayable";
    const mods = tail.replace(/\b(external|public|internal|private|view|pure|payable|virtual|override)\b/g, " ").replace(/returns\s*\([^)]*\)/, " ").split(/\s+/).filter((m) => /^[A-Za-z_]\w*$/.test(m));
    fns.push({ contract, name: f[2]!, visibility: vis, mutability: mut, modifiers: f[1] === "modifier" ? [] : mods, start: i + 1, end: end + 1, lines: lines.slice(i, end + 1) });
  }
  return fns.filter((f) => f.visibility !== "modifier");
}

export type Candidate = { family: string; fn: Fn; claim: string; rationale: string; checks: string[]; alternatives: string[]; spans: Array<{ line: number; end: number; role: "primary" | "supporting" }> };
const abs = (fn: Fn, idx: number) => fn.start + idx; // 1-based absolute line of body line idx

export function analyze(path: string, text: string): { fns: Fn[]; candidates: Candidate[] } {
  const fns = parseFunctions(path, text);
  const out: Candidate[] = [];
  for (const fn of fns) {
    if (!["external", "public"].includes(fn.visibility)) continue;
    const L = fn.lines;
    const callIdx = L.findIndex((l) => /\.call\s*[({]/.test(l) && !/\bstaticcall\b/.test(l));
    const writeAfter = (from: number) => { for (let k = from + 1; k < L.length; k++) if (/\b\w+(\[[^\]]*\])?\s*(-=|\+=|=)(?!=)/.test(L[k]!) && !/\b(bool|uint\d*|address|bytes\d*)\b.*=\s*\w*\.call/.test(L[k]!) && !/^\s*(\(bool|require)/.test(L[k]!)) return k; return -1; };
    // R1: external call, then a state write
    if (callIdx >= 0) {
      const w = writeAfter(callIdx);
      if (w >= 0) out.push({
        family: "solidity-reentrancy-order", fn,
        claim: `${fn.contract}.${fn.name} makes an external call (line ${abs(fn, callIdx)}) before updating state (line ${abs(fn, w)}); a re-entering receiver could observe stale state.`,
        rationale: "Checks-effects-interactions is violated: the call hands control to msg.sender/target while the balance accounting is not yet updated.",
        checks: ["Confirm the callee can re-enter this contract", "Confirm no reentrancy lock or earlier state write protects the path", "Reproduce with a malicious receiver in a local fork test"],
        alternatives: ["A nonReentrant modifier may guard this function", "State may be updated before the call elsewhere in the path"],
        spans: [{ line: abs(fn, callIdx), end: abs(fn, callIdx), role: "primary" }, { line: abs(fn, w), end: abs(fn, w), role: "supporting" }],
      });
    }
    // R2: tx.origin
    const to = L.findIndex((l) => /\btx\s*\.\s*origin\b/.test(l));
    if (to >= 0) out.push({
      family: "solidity-tx-origin", fn,
      claim: `${fn.contract}.${fn.name} references tx.origin (line ${abs(fn, to)}).`,
      rationale: "tx.origin used for authorization lets any contract the owner interacts with act as the owner (phishing relay).",
      checks: ["Determine whether tx.origin is used for authorization or only as an EOA check", "Identify who can be tricked into calling a malicious contract"],
      alternatives: ["It may be an anti-contract check (tx.origin == msg.sender) rather than authorization"],
      spans: [{ line: abs(fn, to), end: abs(fn, to), role: "primary" }],
    });
    // R3: unchecked low-level call/delegatecall (statement whose result is neither captured nor checked)
    for (let k = 0; k < L.length; k++) {
      if (/\.(call|delegatecall|send)\s*[({]/.test(L[k]!) && !/^\s*(\(bool|bool|require|if)\b/.test(L[k]!) && !/=/.test(L[k]!.split(/\.(call|delegatecall|send)/)[0]!)) out.push({
        family: "solidity-unchecked-call", fn,
        claim: `${fn.contract}.${fn.name} ignores the success flag of a low-level call (line ${abs(fn, k)}).`,
        rationale: "A failed call is silently treated as success, so later accounting may diverge from what was actually transferred or executed.",
        checks: ["Confirm the return value is never used on any path", "Find what state is updated assuming success"],
        alternatives: ["The function may be intended best-effort"],
        spans: [{ line: abs(fn, k), end: abs(fn, k), role: "primary" }],
      });
    }
    // R4: delegatecall to a caller-influenced target
    const dc = L.findIndex((l) => /\.delegatecall\s*\(/.test(l));
    if (dc >= 0) out.push({
      family: "solidity-delegatecall-target", fn,
      claim: `${fn.contract}.${fn.name} delegatecalls (line ${abs(fn, dc)}); the target may be caller-controlled.`,
      rationale: "delegatecall runs foreign code against this contract's storage, so a caller-chosen target can overwrite owner/balances or selfdestruct.",
      checks: ["Determine whether the target is a parameter or mutable storage", "Check for an access modifier"],
      alternatives: ["The target may be a constant trusted implementation"],
      spans: [{ line: fn.start, end: fn.start, role: "supporting" }, { line: abs(fn, dc), end: abs(fn, dc), role: "primary" }],
    });
    // R5: unprotected initializer / selfdestruct (no modifier and no msg.sender check)
    const hasGuard = fn.modifiers.length > 0 || L.some((l) => /msg\.sender\s*==|==\s*msg\.sender|require\s*\(\s*!?initialized/.test(l));
    const init = /^(initialize|init|setup)\w*$/i.test(fn.name) && L.some((l) => /\bowner\s*=/.test(l));
    const sd = L.findIndex((l) => /\bselfdestruct\s*\(/.test(l));
    if (!hasGuard && (init || sd >= 0)) {
      const idx = sd >= 0 ? sd : L.findIndex((l) => /\bowner\s*=/.test(l));
      out.push({
        family: init ? "solidity-unprotected-initializer" : "solidity-unprotected-destruct", fn,
        claim: init ? `${fn.contract}.${fn.name} sets the owner with no caller check and no one-time guard (line ${abs(fn, idx)}).`
          : `${fn.contract}.${fn.name} can selfdestruct with no access control (line ${abs(fn, idx)}).`,
        rationale: init ? "Anyone can call the initializer, so anyone can claim ownership (repeatedly, as nothing records that it ran)."
          : "Any caller can destroy the contract and send its balance to themselves.",
        checks: ["Confirm no modifier or inherited guard applies", "Confirm the function is reachable in the deployed configuration"],
        alternatives: ["Access control may be enforced by a proxy or deployment script outside this file"],
        spans: [{ line: fn.start, end: fn.start, role: "supporting" }, { line: abs(fn, idx), end: abs(fn, idx), role: "primary" }],
      });
    }
  }
  return { fns, candidates: out };
}


const FAMILY_TO_CLASS: Record<string, string> = {
  "solidity-reentrancy-order": "reentrancy", "solidity-tx-origin": "tx-origin", "solidity-unchecked-call": "unchecked-call",
  "solidity-delegatecall-target": "delegatecall", "solidity-unprotected-initializer": "initializer", "solidity-unprotected-destruct": "selfdestruct",
};
export function baselineFindings(sources: ReadonlyArray<{ path: string; text: string }>): Array<{ class: string; contract: string; function: string; file: string; line: number }> {
  const out: Array<{ class: string; contract: string; function: string; file: string; line: number }> = [];
  for (const s of sources) for (const c of analyze(s.path, s.text).candidates) out.push({ class: FAMILY_TO_CLASS[c.family] ?? c.family, contract: c.fn.contract, function: c.fn.name, file: s.path, line: c.spans[0]!.line });
  return out;
}
