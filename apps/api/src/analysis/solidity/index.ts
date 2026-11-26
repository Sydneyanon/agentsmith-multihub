import { parseSolidity, type ContractDef, type FunctionDef, type ParsedFile, type StateVar } from "./parser.js";

/** All parsed contracts of one snapshot, with inheritance resolved so helpers and modifiers are found where Solidity would find them. */
export class ProgramIndex {
  readonly contracts = new Map<string, ContractDef>();
  readonly files: ParsedFile[] = [];
  readonly problems: string[] = [];
  /** file -> true when its pragma allows pre-0.8 compilers, where arithmetic wraps instead of reverting */
  readonly wrapsArithmetic = new Map<string, boolean>();

  constructor(sources: ReadonlyArray<{ path: string; text: string }>) {
    for (const s of sources) {
      const pr = /pragma\s+solidity\s+([^;]+);/.exec(s.text.replace(/\/\/.*$/gm, ""));
      const ver = pr ? /(\d+)\.(\d+)/.exec(pr[1]!) : null;
      this.wrapsArithmetic.set(s.path, ver ? Number(ver[1]) === 0 && Number(ver[2]) < 8 : false);
      const parsed = parseSolidity(s.path, s.text);
      this.files.push(parsed);
      for (const p of parsed.problems) this.problems.push(`${s.path}: ${p}`);
      for (const c of parsed.contracts) { if (this.contracts.has(c.name)) this.problems.push(`${s.path}: duplicate contract name ${c.name} (first definition kept)`); else this.contracts.set(c.name, c); }
    }
  }

  /** The contract followed by its bases, most-derived first (right-most base first, as in Solidity linearisation). */
  linearize(name: string, seen = new Set<string>()): ContractDef[] {
    const c = this.contracts.get(name); if (!c || seen.has(name)) return [];
    seen.add(name);
    const out: ContractDef[] = [c];
    for (const b of [...c.bases].reverse()) out.push(...this.linearize(b, seen));
    return out;
  }

  findFunctions(contract: string, name: string): FunctionDef[] {
    const out: FunctionDef[] = [];
    for (const c of this.linearize(contract)) for (const f of c.functions) if (f.name === name && f.kind === "function") out.push(f);
    return out;
  }
  /** the most-derived definition matching the argument count (overloads are resolved by arity only) */
  findFunction(contract: string, name: string, argc: number): FunctionDef | null {
    const all = this.findFunctions(contract, name);
    return all.find((f) => f.params.length === argc && f.body) ?? all.find((f) => f.params.length === argc) ?? all[0] ?? null;
  }
  findModifier(contract: string, name: string): FunctionDef | null {
    for (const c of this.linearize(contract)) for (const m of c.modifiers) if (m.name === name) return m;
    return null;
  }
  stateVar(contract: string, name: string): (StateVar & { owner: string }) | null {
    for (const c of this.linearize(contract)) for (const v of c.stateVars) if (v.name === name) return { ...v, owner: c.name };
    return null;
  }
  isContractLike(name: string): boolean { return this.contracts.has(name); }
  /** every external/public function declared on the contract itself (inherited ones are analysed in their own contract) */
  entryPoints(contract: string): FunctionDef[] {
    const c = this.contracts.get(contract); if (!c) return [];
    return c.functions.filter((f) => (f.kind === "function" || f.kind === "receive" || f.kind === "fallback") && (f.visibility === "external" || f.visibility === "public") && f.body && f.mutability !== "view" && f.mutability !== "pure");
  }
}
