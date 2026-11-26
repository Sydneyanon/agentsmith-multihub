import { lex, type Token } from "./lexer.js";

/**
 * Structural Solidity parser. Pragmatic, not a compiler: it recovers contracts, inheritance, state variables, functions, modifiers,
 * statements and expressions well enough for security analysis, and it NEVER guesses silently: anything it cannot parse becomes a
 * `raw` node, and the analyses treat `raw` as "unknown" so they abstain rather than assert.
 */
export type Expr =
  | { k: "id"; name: string; line: number }
  | { k: "num"; v: bigint | null; text: string; line: number }
  | { k: "str"; line: number }
  | { k: "bool"; v: boolean; line: number }
  | { k: "member"; obj: Expr; name: string; line: number }
  | { k: "index"; obj: Expr; idx: Expr | null; line: number }
  | { k: "call"; fn: Expr; args: Expr[]; opts: Record<string, Expr>; line: number }
  | { k: "unary"; op: string; e: Expr; line: number }
  | { k: "binary"; op: string; l: Expr; r: Expr; line: number }
  | { k: "assign"; op: string; l: Expr; r: Expr; line: number }
  | { k: "update"; op: "++" | "--"; e: Expr; line: number }
  | { k: "ternary"; c: Expr; a: Expr; b: Expr; line: number }
  | { k: "tuple"; items: Array<Expr | null>; line: number }
  | { k: "new"; type: string; args: Expr[]; line: number }
  | { k: "delete"; e: Expr; line: number }
  | { k: "raw"; text: string; line: number };

export type Stmt =
  | { k: "expr"; e: Expr; line: number }
  | { k: "decl"; names: Array<string | null>; types: string[]; init: Expr | null; line: number }
  | { k: "if"; cond: Expr; then: Stmt[]; els: Stmt[]; line: number }
  | { k: "loop"; cond: Expr | null; body: Stmt[]; line: number }
  | { k: "block"; body: Stmt[]; unchecked: boolean; line: number }
  | { k: "return"; e: Expr | null; line: number }
  | { k: "revert"; line: number }
  | { k: "emit"; line: number }
  | { k: "placeholder"; line: number }
  | { k: "try"; call: Expr; body: Stmt[]; catches: Stmt[][]; line: number }
  | { k: "asm"; line: number }
  | { k: "other"; line: number };

export type Param = { type: string; name: string | null };
export type ModifierUse = { name: string; args: Expr[]; line: number };
export type FunctionDef = {
  kind: "function" | "constructor" | "receive" | "fallback" | "modifier";
  name: string; contract: string; file: string;
  params: Param[]; returns: Param[]; visibility: string; mutability: string;
  modifiers: ModifierUse[]; virtual: boolean;
  startLine: number; endLine: number; body: Stmt[] | null;
};
export type StateVar = { name: string; type: string; visibility: string; constant: boolean; immutable: boolean; init: Expr | null; line: number };
export type ContractDef = {
  name: string; kind: "contract" | "interface" | "library" | "abstract"; file: string; bases: string[];
  stateVars: StateVar[]; functions: FunctionDef[]; modifiers: FunctionDef[]; startLine: number; endLine: number;
};
export type ParsedFile = { file: string; contracts: ContractDef[]; problems: string[] };

const VISIBILITY = new Set(["external", "public", "internal", "private"]);
const MUTABILITY = new Set(["view", "pure", "payable", "nonpayable"]);
const LOCATION = new Set(["memory", "calldata", "storage"]);
const UNITS: Record<string, bigint> = { wei: 1n, gwei: 10n ** 9n, ether: 10n ** 18n, seconds: 1n, minutes: 60n, hours: 3600n, days: 86400n, weeks: 604800n };

class P {
  p = 0;
  constructor(readonly t: Token[], readonly problems: string[], readonly end = t.length) {}
  get cur(): Token | undefined { return this.p < this.end ? this.t[this.p] : undefined; }
  peek(o = 0): Token | undefined { return this.p + o < this.end ? this.t[this.p + o] : undefined; }
  is(v: string, o = 0): boolean { return this.peek(o)?.v === v && this.peek(o)?.k !== "str"; }
  eat(v: string): boolean { if (this.is(v)) { this.p++; return true; } return false; }
  line(): number { return this.cur?.line ?? this.t[this.t.length - 1]?.line ?? 0; }
  /** index just after the group that opens at `open` (a "(", "[" or "{"), or `end` when unbalanced */
  skipGroup(open: number): number {
    const o = this.t[open]!.v; const c = o === "(" ? ")" : o === "[" ? "]" : "}";
    let d = 0;
    for (let i = open; i < this.end; i++) {
      const tk = this.t[i]!; if (tk.k !== "op") continue;
      if (tk.v === o) d++; else if (tk.v === c) { d--; if (d === 0) return i + 1; }
    }
    return this.end;
  }
  skipTo(v: string): void { // to just after the next `v` at depth 0
    while (this.p < this.end) {
      const tk = this.t[this.p]!;
      if (tk.k === "op" && (tk.v === "(" || tk.v === "[" || tk.v === "{")) { this.p = this.skipGroup(this.p); continue; }
      this.p++; if (tk.k === "op" && tk.v === v) return;
    }
  }
}

// ------------------------------------------------------------------ expressions
const BIN: Record<string, [number, boolean]> = {
  "||": [3, false], "&&": [4, false], "==": [5, false], "!=": [5, false], "<": [6, false], ">": [6, false], "<=": [6, false], ">=": [6, false],
  "|": [7, false], "^": [8, false], "&": [9, false], "<<": [10, false], ">>": [10, false], ">>>": [10, false],
  "+": [11, false], "-": [11, false], "*": [12, false], "/": [12, false], "%": [12, false], "**": [13, true],
};
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

function parseExpr(ps: P, minPrec = 0): Expr {
  let left = parseUnary(ps);
  for (;;) {
    const t = ps.cur; if (!t || t.k !== "op") break;
    if (ASSIGN.has(t.v)) { if (minPrec > 1) break; ps.p++; const r = parseExpr(ps, 1); left = { k: "assign", op: t.v, l: left, r, line: t.line }; continue; }
    if (t.v === "?") { if (minPrec > 2) break; ps.p++; const a = parseExpr(ps, 1); ps.eat(":"); const b = parseExpr(ps, 2); left = { k: "ternary", c: left, a, b, line: t.line }; continue; }
    const info = BIN[t.v]; if (!info || info[0] < minPrec) break;
    ps.p++; const r = parseExpr(ps, info[1] ? info[0] : info[0] + 1);
    left = { k: "binary", op: t.v, l: left, r, line: t.line };
  }
  return left;
}

function parseUnary(ps: P): Expr {
  const t = ps.cur; if (!t) return { k: "raw", text: "", line: ps.line() };
  if (t.k === "op" && (t.v === "!" || t.v === "~" || t.v === "-" || t.v === "+")) { ps.p++; return { k: "unary", op: t.v, e: parseUnary(ps), line: t.line }; }
  if (t.k === "op" && (t.v === "++" || t.v === "--")) { ps.p++; const e = parseUnary(ps); return { k: "update", op: t.v, e, line: t.line }; }
  if (t.k === "id" && t.v === "delete") { ps.p++; return { k: "delete", e: parseUnary(ps), line: t.line }; }
  return parsePostfix(ps);
}

function parsePostfix(ps: P): Expr {
  let e = parsePrimary(ps);
  for (;;) {
    const t = ps.cur; if (!t || t.k !== "op") break;
    if (t.v === ".") { ps.p++; const n = ps.cur; if (n && n.k === "id") { ps.p++; e = { k: "member", obj: e, name: n.v, line: n.line }; } else break; continue; }
    if (t.v === "[") {
      ps.p++; if (ps.is("]")) { ps.p++; e = { k: "index", obj: e, idx: null, line: t.line }; continue; }
      const idx = parseExpr(ps); if (ps.is(":")) { ps.p++; if (!ps.is("]")) parseExpr(ps); } ps.eat("]"); e = { k: "index", obj: e, idx, line: t.line }; continue;
    }
    if (t.v === "{" && ps.peek(1)?.k === "id" && ps.is(":", 2)) { // call options: .call{value: x, gas: y}
      ps.p++; const opts: Record<string, Expr> = {};
      while (ps.cur && !ps.is("}")) { const name = ps.cur.v; ps.p++; ps.eat(":"); opts[name] = parseExpr(ps, 1); if (!ps.eat(",")) break; }
      ps.eat("}");
      if (ps.is("(")) { const args = parseArgs(ps); e = { k: "call", fn: e, args, opts, line: t.line }; }
      continue;
    }
    if (t.v === "(") { const args = parseArgs(ps); e = { k: "call", fn: e, args, opts: {}, line: t.line }; continue; }
    if (t.v === "++" || t.v === "--") { ps.p++; e = { k: "update", op: t.v, e, line: t.line }; continue; }
    break;
  }
  return e;
}

function parseArgs(ps: P): Expr[] {
  ps.eat("("); const args: Expr[] = [];
  if (ps.is("{")) { // named arguments f({a: 1})
    ps.p++; while (ps.cur && !ps.is("}")) { ps.p++; ps.eat(":"); args.push(parseExpr(ps, 1)); if (!ps.eat(",")) break; } ps.eat("}");
  } else {
    while (ps.cur && !ps.is(")")) { const before = ps.p; args.push(parseExpr(ps, 1)); if (!ps.eat(",")) break; if (ps.p === before) break; }
  }
  ps.eat(")"); return args;
}

function parsePrimary(ps: P): Expr {
  const t = ps.cur; if (!t) return { k: "raw", text: "", line: ps.line() };
  if (t.k === "num") {
    ps.p++; let v: bigint | null = null;
    try { v = /^[0-9]+$/.test(t.v) || /^0[xX][0-9a-fA-F]+$/.test(t.v) ? BigInt(t.v) : /^[0-9]+[eE][0-9]+$/.test(t.v) ? BigInt(t.v.split(/[eE]/)[0]!) * 10n ** BigInt(t.v.split(/[eE]/)[1]!) : null; } catch { v = null; }
    const unit = ps.cur?.k === "id" ? UNITS[ps.cur.v] : undefined;
    if (unit !== undefined) { ps.p++; if (v !== null) v = v * unit; }
    return { k: "num", v, text: t.v, line: t.line };
  }
  if (t.k === "str") { ps.p++; while (ps.cur?.k === "str") ps.p++; return { k: "str", line: t.line }; }
  if (t.k === "op" && t.v === "(") {
    ps.p++; const items: Array<Expr | null> = [];
    while (ps.cur && !ps.is(")")) { if (ps.is(",")) { items.push(null); ps.p++; continue; } items.push(parseExpr(ps, 1)); if (!ps.eat(",")) break; if (ps.is(")")) items.push(null); }
    ps.eat(")");
    return items.length === 1 && items[0] ? items[0] : { k: "tuple", items, line: t.line };
  }
  if (t.k === "op" && t.v === "[") { ps.p++; const items: Expr[] = []; while (ps.cur && !ps.is("]")) { items.push(parseExpr(ps, 1)); if (!ps.eat(",")) break; } ps.eat("]"); return { k: "tuple", items, line: t.line }; }
  if (t.k === "id") {
    if (t.v === "true" || t.v === "false") { ps.p++; return { k: "bool", v: t.v === "true", line: t.line }; }
    if (t.v === "new") {
      ps.p++; let type = ""; while (ps.cur && !ps.is("(") && !ps.is(";")) { type += ps.cur.v; ps.p++; }
      const args = ps.is("(") ? parseArgs(ps) : []; return { k: "new", type, args, line: t.line };
    }
    if (t.v === "mapping") { const e = ps.skipGroup(ps.p + 1); ps.p = e; return { k: "raw", text: "mapping", line: t.line }; }
    ps.p++; return { k: "id", name: t.v, line: t.line };
  }
  ps.p++; return { k: "raw", text: t.v, line: t.line };
}

export function exprText(e: Expr | null | undefined): string {
  if (!e) return "";
  switch (e.k) {
    case "id": return e.name;
    case "num": return e.text;
    case "str": return '"..."';
    case "bool": return String(e.v);
    case "member": return `${exprText(e.obj)}.${e.name}`;
    case "index": return `${exprText(e.obj)}[${exprText(e.idx)}]`;
    case "call": return `${exprText(e.fn)}(${e.args.map(exprText).join(", ")})`;
    case "unary": return `${e.op}${exprText(e.e)}`;
    case "binary": return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case "assign": return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case "update": return `${exprText(e.e)}${e.op}`;
    case "ternary": return `${exprText(e.c)} ? ${exprText(e.a)} : ${exprText(e.b)}`;
    case "tuple": return `(${e.items.map((i) => exprText(i)).join(", ")})`;
    case "new": return `new ${e.type}`;
    case "delete": return `delete ${exprText(e.e)}`;
    case "raw": return e.text;
  }
}

// ------------------------------------------------------------------ statements
const ELEMENTARY = /^(address|bool|string|bytes\d*|u?int\d*|u?fixed\d*|byte)$/;

/** does a declaration start here? returns the number of tokens of the type part and the name, or null */
function declLookahead(ps: P): { typeEnd: number; name: string | null; nameTok: number } | null {
  let i = ps.p; const t = ps.t; const e = ps.end;
  const first = t[i]; if (!first || first.k !== "id") return null;
  if (first.v === "mapping") { i = ps.skipGroup(i + 1); }
  else {
    if (["return", "emit", "revert", "if", "for", "while", "do", "try", "delete", "new", "unchecked", "assembly", "break", "continue", "require", "assert"].includes(first.v)) return null;
    i++;
    while (i + 1 < e && t[i]?.v === "." && t[i + 1]?.k === "id") i += 2;
  }
  if (first.v === "address" && t[i]?.v === "payable") i++;
  while (t[i]?.v === "[") i = ps.skipGroup(i);
  while (i < e && t[i]?.k === "id" && LOCATION.has(t[i]!.v)) i++;
  if (t[i]?.v === "payable") i++;
  const nm = t[i]; if (!nm || nm.k !== "id") return null;
  const after = t[i + 1];
  if (!after || !(after.v === "=" || after.v === ";" || after.v === "," || after.v === ")")) return null;
  if (LOCATION.has(nm.v) || VISIBILITY.has(nm.v)) return null;
  return { typeEnd: i, name: nm.v, nameTok: i };
}

function parseBlockBody(ps: P): Stmt[] {
  const out: Stmt[] = []; ps.eat("{");
  while (ps.cur && !ps.is("}")) { const before = ps.p; out.push(...parseStatement(ps)); if (ps.p === before) ps.p++; }
  ps.eat("}"); return out;
}

function parseStmtList(ps: P): Stmt[] { if (ps.is("{")) return parseBlockBody(ps); return parseStatement(ps); }

function endStatement(ps: P): void { if (!ps.eat(";")) ps.skipTo(";"); }

function parseStatement(ps: P): Stmt[] {
  const t = ps.cur; if (!t) return [];
  const line = t.line;
  if (t.k === "op" && t.v === "{") return [{ k: "block", body: parseBlockBody(ps), unchecked: false, line }];
  if (t.k === "op" && t.v === ";") { ps.p++; return []; }
  if (t.k === "id") {
    switch (t.v) {
      case "unchecked": if (ps.is("{", 1)) { ps.p++; return [{ k: "block", body: parseBlockBody(ps), unchecked: true, line }]; } break;
      case "if": {
        ps.p++; ps.eat("("); const cond = parseExpr(ps); ps.eat(")");
        const then = parseStmtList(ps); let els: Stmt[] = []; if (ps.is("else")) { ps.p++; els = parseStmtList(ps); }
        return [{ k: "if", cond, then, els, line }];
      }
      case "for": {
        ps.p++; ps.eat("("); const pre: Stmt[] = [];
        if (!ps.is(";")) pre.push(...parseStatement(ps)); else ps.p++;
        let cond: Expr | null = null; if (!ps.is(";")) cond = parseExpr(ps); ps.eat(";");
        let post: Expr | null = null; if (!ps.is(")")) post = parseExpr(ps); ps.eat(")");
        const body = parseStmtList(ps); if (post) body.push({ k: "expr", e: post, line });
        return [...pre, { k: "loop", cond, body, line }];
      }
      case "while": { ps.p++; ps.eat("("); const cond = parseExpr(ps); ps.eat(")"); return [{ k: "loop", cond, body: parseStmtList(ps), line }]; }
      case "do": { ps.p++; const body = parseStmtList(ps); ps.eat("while"); ps.eat("("); const cond = parseExpr(ps); ps.eat(")"); endStatement(ps); return [{ k: "loop", cond, body, line }]; }
      case "return": { ps.p++; let e: Expr | null = null; if (!ps.is(";")) e = parseExpr(ps); endStatement(ps); return [{ k: "return", e, line }]; }
      case "emit": { ps.skipTo(";"); return [{ k: "emit", line }]; }
      case "revert": { ps.skipTo(";"); return [{ k: "revert", line }]; }
      case "break": case "continue": { ps.skipTo(";"); return [{ k: "other", line }]; }
      case "assembly": {
        ps.p++; while (ps.cur && !ps.is("{")) ps.p++; if (ps.is("{")) ps.p = ps.skipGroup(ps.p); return [{ k: "asm", line }];
      }
      case "try": {
        ps.p++; const call = parseExpr(ps);
        if (ps.is("returns")) { ps.p++; if (ps.is("(")) ps.p = ps.skipGroup(ps.p); }
        const body = parseBlockBody(ps); const catches: Stmt[][] = [];
        while (ps.is("catch")) { ps.p++; while (ps.cur && !ps.is("{")) { if (ps.is("(")) ps.p = ps.skipGroup(ps.p); else ps.p++; } catches.push(parseBlockBody(ps)); }
        return [{ k: "try", call, body, catches, line }];
      }
      case "_": if (ps.is(";", 1)) { ps.p += 2; return [{ k: "placeholder", line }]; } break;
    }
  }
  // tuple declaration: (bool ok, bytes memory data) = ...
  if (t.k === "op" && t.v === "(") {
    const close = ps.skipGroup(ps.p);
    if (ps.t[close]?.v === "=") {
      const inner = new P(ps.t, ps.problems, close - 1); inner.p = ps.p + 1;
      const names: Array<string | null> = []; const types: string[] = []; let isDecl = false;
      while (inner.p < inner.end) {
        if (inner.is(",")) { names.push(null); types.push(""); inner.p++; continue; }
        const d = declLookahead(inner);
        if (d) { isDecl = true; names.push(d.name); types.push(ps.t.slice(inner.p, d.typeEnd).map((x) => x.v).join(" ")); inner.p = d.nameTok + 1; }
        else { const ex = parseExpr(inner, 1); names.push(exprText(ex)); types.push(""); }
        if (!inner.eat(",")) break;
        if (inner.p >= inner.end) { names.push(null); types.push(""); }
      }
      if (isDecl) { ps.p = close + 1; const init = parseExpr(ps); endStatement(ps); return [{ k: "decl", names, types, init, line }]; }
    }
  }
  const d = declLookahead(ps);
  if (d) {
    const type = ps.t.slice(ps.p, d.typeEnd).map((x) => x.v).join(" "); ps.p = d.nameTok + 1;
    let init: Expr | null = null; if (ps.eat("=")) init = parseExpr(ps);
    endStatement(ps); return [{ k: "decl", names: [d.name], types: [type], init, line }];
  }
  const e = parseExpr(ps); const before = ps.p; endStatement(ps);
  if (ps.p === before && e.k === "raw") return [{ k: "other", line }];
  return [{ k: "expr", e, line }];
}

// ------------------------------------------------------------------ declarations
function parseParams(ps: P): Param[] {
  const out: Param[] = []; if (!ps.is("(")) return out;
  const close = ps.skipGroup(ps.p); let i = ps.p + 1; let cur: Token[] = []; let d = 0;
  const flush = () => {
    if (!cur.length) return;
    const words = cur.filter((x) => !(x.k === "id" && LOCATION.has(x.v)));
    const last = words[words.length - 1];
    const hasName = words.length >= 2 && last?.k === "id" && last.v !== "payable" && !(words.length === 2 && words[0]?.v === "address" && last.v === "payable");
    out.push({ type: (hasName ? words.slice(0, -1) : words).map((x) => x.v).join(" "), name: hasName ? last!.v : null }); cur = [];
  };
  for (; i < close - 1; i++) {
    const tk = ps.t[i]!;
    if (tk.k === "op" && (tk.v === "(" || tk.v === "[")) d++;
    if (tk.k === "op" && (tk.v === ")" || tk.v === "]")) d--;
    if (tk.k === "op" && tk.v === "," && d === 0) { flush(); continue; }
    cur.push(tk);
  }
  flush(); ps.p = close; return out;
}

function parseFunction(ps: P, contract: string, file: string): FunctionDef | null {
  const start = ps.cur!; const kw = start.v; ps.p++;
  let name = kw; let kind: FunctionDef["kind"] = kw === "constructor" ? "constructor" : kw === "receive" ? "receive" : kw === "fallback" ? "fallback" : kw === "modifier" ? "modifier" : "function";
  if (kind === "function" || kind === "modifier") { if (ps.cur?.k === "id") { name = ps.cur.v; ps.p++; } else if (ps.is("(")) { name = ""; if (kind === "function") kind = "fallback"; } }
  const params = parseParams(ps);
  let returns: Param[] = []; let visibility = ""; let mutability = ""; let virtual = false; const modifiers: ModifierUse[] = [];
  while (ps.cur && !ps.is("{") && !ps.is(";")) {
    const tk = ps.cur;
    if (tk.k !== "id") { ps.p++; continue; }
    if (VISIBILITY.has(tk.v)) { visibility = tk.v; ps.p++; continue; }
    if (MUTABILITY.has(tk.v)) { mutability = tk.v; ps.p++; continue; }
    if (tk.v === "virtual") { virtual = true; ps.p++; continue; }
    if (tk.v === "override") { ps.p++; if (ps.is("(")) ps.p = ps.skipGroup(ps.p); continue; }
    if (tk.v === "returns") { ps.p++; returns = parseParams(ps); continue; }
    let mname = tk.v; ps.p++; while (ps.is(".") && ps.peek(1)?.k === "id") { mname += "." + ps.peek(1)!.v; ps.p += 2; }
    const args = ps.is("(") ? parseArgs(ps) : []; modifiers.push({ name: mname, args, line: tk.line });
  }
  let body: Stmt[] | null = null; let endLine = ps.line();
  if (ps.is("{")) { const close = ps.skipGroup(ps.p); endLine = ps.t[close - 1]?.line ?? endLine; body = parseBlockBody(ps); } else ps.eat(";");
  if (kind === "constructor" || kind === "receive" || kind === "fallback") { if (!visibility) visibility = kind === "constructor" ? "public" : "external"; }
  return { kind, name, contract, file, params, returns, visibility: visibility || (kind === "modifier" ? "internal" : "public"), mutability: mutability || "nonpayable", modifiers, virtual, startLine: start.line, endLine, body };
}

function parseStateVar(ps: P): StateVar | null {
  const startLine = ps.line(); const begin = ps.p;
  // find ';' at depth 0 and the '=' at depth 0
  let i = ps.p; let d = 0; let eq = -1;
  for (; i < ps.end; i++) {
    const tk = ps.t[i]!; if (tk.k !== "op") continue;
    if (tk.v === "(" || tk.v === "[" || tk.v === "{") d++; else if (tk.v === ")" || tk.v === "]" || tk.v === "}") d--;
    else if (d === 0 && tk.v === "=" && eq < 0) eq = i; else if (d === 0 && tk.v === ";") break;
  }
  const declEnd = eq >= 0 ? eq : i; const decl = ps.t.slice(begin, declEnd);
  let init: Expr | null = null;
  if (eq >= 0) { const sub = new P(ps.t, ps.problems, i); sub.p = eq + 1; init = parseExpr(sub); }
  ps.p = i + 1;
  const attrs = new Set(["public", "private", "internal", "constant", "immutable", "override", "transient"]);
  const ids = decl.filter((x) => x.k === "id"); if (ids.length < 2) return null;
  const name = ids[ids.length - 1]!.v;
  const typeToks: string[] = []; let vis = ""; let constant = false; let immutable = false;
  for (let j = 0; j < decl.length - 1; j++) {
    const tk = decl[j]!;
    if (tk.k === "id" && attrs.has(tk.v)) { if (tk.v === "constant") constant = true; else if (tk.v === "immutable") immutable = true; else if (tk.v !== "override" && tk.v !== "transient") vis = tk.v; if (tk.v === "override" && decl[j + 1]?.v === "(") { /* skipped by grouping below */ } continue; }
    typeToks.push(tk.v);
  }
  return { name, type: typeToks.join(" ").replace(/\s+/g, " ").trim(), visibility: vis || "internal", constant, immutable, init, line: startLine };
}

function parseContract(ps: P, file: string): ContractDef | null {
  let kind: ContractDef["kind"] = "contract"; const startLine = ps.line();
  if (ps.is("abstract")) { ps.p++; kind = "abstract"; }
  const kw = ps.cur?.v; ps.p++; if (kw === "interface") kind = "interface"; else if (kw === "library") kind = "library";
  const name = ps.cur?.v ?? ""; ps.p++;
  const bases: string[] = [];
  if (ps.is("is")) {
    ps.p++;
    while (ps.cur && !ps.is("{")) {
      if (ps.cur.k === "id") { let b = ps.cur.v; ps.p++; while (ps.is(".") && ps.peek(1)?.k === "id") { b = ps.peek(1)!.v; ps.p += 2; } bases.push(b); if (ps.is("(")) ps.p = ps.skipGroup(ps.p); } else ps.p++;
    }
  }
  const def: ContractDef = { name, kind, file, bases, stateVars: [], functions: [], modifiers: [], startLine, endLine: startLine };
  if (!ps.is("{")) return def;
  const close = ps.skipGroup(ps.p); const bodyEnd = close - 1; ps.p++;
  const inner = new P(ps.t, ps.problems, bodyEnd); inner.p = ps.p;
  while (inner.p < bodyEnd) {
    const t = inner.cur!; const before = inner.p;
    if (t.k === "id") {
      if (["function", "constructor", "receive", "fallback", "modifier"].includes(t.v)) {
        if ((t.v === "receive" || t.v === "fallback" || t.v === "constructor") && !inner.is("(", 1)) { /* a state var named receive? treat as var */ }
        const f = parseFunction(inner, name, file);
        if (f) { if (f.kind === "modifier") def.modifiers.push(f); else def.functions.push(f); }
        continue;
      }
      if (["event", "error", "using", "type"].includes(t.v)) { inner.skipTo(";"); continue; }
      if (t.v === "struct" || t.v === "enum") { while (inner.cur && !inner.is("{")) inner.p++; if (inner.is("{")) inner.p = inner.skipGroup(inner.p); continue; }
      const sv = parseStateVar(inner); if (sv) def.stateVars.push(sv); continue;
    }
    inner.p++; if (inner.p === before) inner.p++;
  }
  ps.p = close; def.endLine = ps.t[close - 1]?.line ?? startLine;
  return def;
}

export function parseSolidity(file: string, source: string): ParsedFile {
  const toks = lex(source); const problems: string[] = []; const ps = new P(toks, problems);
  const contracts: ContractDef[] = [];
  while (ps.cur) {
    const t = ps.cur;
    if (t.k === "id" && (t.v === "pragma" || t.v === "import" || t.v === "using" || t.v === "error" || t.v === "event" || t.v === "type")) { ps.skipTo(";"); continue; }
    if (t.k === "id" && (t.v === "contract" || t.v === "interface" || t.v === "library" || (t.v === "abstract" && ps.is("contract", 1)))) {
      const c = parseContract(ps, file); if (c) contracts.push(c); continue;
    }
    if (t.k === "id" && (t.v === "struct" || t.v === "enum")) { while (ps.cur && !ps.is("{")) ps.p++; if (ps.is("{")) ps.p = ps.skipGroup(ps.p); continue; }
    if (t.k === "id" && t.v === "function") { const f = parseFunction(ps, "<file>", file); if (f) problems.push(`free function ${f.name} is not analysed`); continue; }
    ps.p++;
  }
  return { file, contracts, problems };
}
