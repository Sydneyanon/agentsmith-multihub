/**
 * Dependency-free Solidity lexer. Passive: it only reads text. Comments (including NatSpec) are dropped and string contents are replaced
 * by an opaque token, so words such as "call" or "tx.origin" inside comments or strings can never be mistaken for code.
 */
export type Token = { k: "id" | "num" | "str" | "op"; v: string; line: number };

const OPS3 = new Set(["<<=", ">>=", ">>>", "**="]);
const OPS2 = new Set(["==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**", "=>", "->", ":="]);

export function lex(source: string): Token[] {
  const out: Token[] = [];
  let i = 0; let line = 1;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) { if (source[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    // string literals (optionally prefixed by unicode / hex)
    const prefixed = /^(unicode|hex)(["'])/.exec(source.slice(i, i + 8));
    if (c === '"' || c === "'" || prefixed) {
      if (prefixed) i += prefixed[1]!.length;
      const q = source[i]!; const startLine = line; i++;
      while (i < n && source[i] !== q) { if (source[i] === "\\") i++; if (source[i] === "\n") line++; i++; }
      i++;
      out.push({ k: "str", v: "<str>", line: startLine }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < n && /[\w$]/.test(source[j]!)) j++;
      out.push({ k: "id", v: source.slice(i, j), line }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1; while (j < n && /[0-9a-fA-FxX_.eE]/.test(source[j]!)) {
        // do not swallow a member access such as 1.5 ether vs x.y: a dot must be followed by a digit
        if (source[j] === "." && !/[0-9]/.test(source[j + 1] ?? "")) break;
        j++;
      }
      out.push({ k: "num", v: source.slice(i, j).replace(/_/g, ""), line }); i = j; continue;
    }
    const three = source.slice(i, i + 3); const two = source.slice(i, i + 2);
    if (OPS3.has(three)) { out.push({ k: "op", v: three, line }); i += 3; continue; }
    if (OPS2.has(two)) { out.push({ k: "op", v: two, line }); i += 2; continue; }
    out.push({ k: "op", v: c, line }); i++;
  }
  return out;
}
