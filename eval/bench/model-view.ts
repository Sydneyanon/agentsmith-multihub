/**
 * Model-facing view of a benchmark corpus. benchmark-b's raw files are written for human reviewers: they carry explanatory
 * comments (`// BUG (oracle-manipulation): ...`) and contract names ending in Bad/Good. A deterministic, comment-blind parser is
 * unaffected, but for any MODEL-based capability those files are the answer key. Anything shown to a model must go through this
 * view:
 *   - comments are blanked to spaces (newlines kept, so every line number stays valid),
 *   - every declared contract/library name is replaced by a neutral, stable token, and file paths likewise,
 *   - `redact()` applies the same mapping to any other text that will be shown (e.g. an analyzer claim naming a contract).
 * The mapping stays with the runner and is never sent to the model.
 */
import { createHash } from "node:crypto";

/** Blanks // line comments and /* block *\/ comments (including NatSpec), leaving string literals and newlines intact. */
export function stripComments(text: string): string {
  let out = ""; let i = 0;
  while (i < text.length) {
    const c = text[i]!; const n = text[i + 1];
    if (c === '"' || c === "'") { // string literal: copy verbatim up to the matching unescaped quote
      let j = i + 1; while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && n === "*") {
      out += "  "; i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      if (i < text.length) { out += "  "; i += 2; }
    } else { out += c; i++; }
  }
  return out;
}

const token = (kind: string, name: string) => `${kind}_${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;

export function buildModelView(sources: Array<{ path: string; text: string }>) {
  const names = new Map<string, string>();
  for (const s of sources) for (const m of stripComments(s.text).matchAll(/\b(?:abstract\s+)?(contract|library)\s+([A-Za-z_]\w*)/g)) names.set(m[2]!, token("Contract", m[2]!));
  const files = new Map(sources.map((s) => [s.path, `contracts/${token("file", s.path)}.sol`]));
  const ordered = [...names.entries()].sort((a, b) => b[0].length - a[0].length); // longest first: no partial overlaps
  const redact = (text: string) => {
    let t = text;
    for (const [orig, neutral] of files) t = t.split(orig).join(neutral);
    for (const [orig, neutral] of ordered) t = t.replace(new RegExp(`\\b${orig}\\b`, "g"), neutral);
    return t;
  };
  const view = new Map(sources.map((s) => [s.path, redact(stripComments(s.text))]));
  return { redact, text: (path: string) => view.get(path) ?? "", neutralPath: (path: string) => files.get(path) ?? path };
}
export type ModelView = ReturnType<typeof buildModelView>;
