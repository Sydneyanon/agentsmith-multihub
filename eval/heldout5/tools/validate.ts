/**
 * Corpus 5 hand-back validator, safe for the ANALYZER side to run: it checks both files against the brief's rules and prints ONLY
 * counts and the positions of errors (entry index, field name). It never prints a repository, path, function, class, URL or note
 * from ground-truth.json, so running it does not unblind the operator.
 *   npx tsx eval/heldout5/tools/validate.ts <selection.json> <ground-truth.json>
 * Exit 0 = valid; 1 = invalid (errors listed by position only).
 */
import { readFileSync } from "node:fs";

type Obj = Record<string, unknown>;
const CLASSES = /^(reentrancy|access-control|initializer|delegatecall|selfdestruct|unchecked-call|tx-origin|other:.{3,80})$/;
const SHA = /^[0-9a-f]{40}$/; const ID = /^c5-[0-9]{2}$/;

export function validate(sel: Obj, gt: Obj): { errors: string[]; counts: Record<string, number> } {
  const errors: string[] = [];
  const err = (where: string, what: string) => errors.push(`${where}: ${what}`);
  if (sel.version !== "corpus5-selection/1") err("selection.version", "unexpected");
  if (gt.version !== "corpus5-ground-truth/1") err("ground-truth.version", "unexpected");
  const entries = Array.isArray(sel.entries) ? (sel.entries as Obj[]) : [];
  if (entries.length < 20 || entries.length > 30) err("selection.entries", `count ${entries.length} outside 20-30`);
  const ids = new Set<string>(); const repoCommit = new Set<string>();
  entries.forEach((e, i) => {
    const w = `selection.entries[${i}]`;
    if (typeof e.id !== "string" || !ID.test(e.id)) err(w, "id"); else if (ids.has(e.id)) err(w, "duplicate id"); else ids.add(e.id);
    if (!["vulnerable", "post_fix_control", "clean_control"].includes(String(e.kind))) err(w, "kind");
    if (typeof e.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repository)) err(w, "repository");
    if (/not-so-smart-contracts|agentsmith/i.test(String(e.repository))) err(w, "excluded repository");
    if (typeof e.commit_sha !== "string" || !SHA.test(e.commit_sha)) err(w, "commit_sha"); if (typeof e.tree_sha !== "string" || !SHA.test(e.tree_sha)) err(w, "tree_sha");
    const rc = `${e.repository}@${e.commit_sha}`; if (repoCommit.has(rc)) err(w, "duplicate repository+commit"); repoCommit.add(rc);
    if (!Array.isArray(e.in_scope_paths) || e.in_scope_paths.length === 0) err(w, "in_scope_paths");
    if (typeof e.prior_knowledge_risk !== "boolean") err(w, "prior_knowledge_risk");
    if (e.kind === "post_fix_control" && (typeof e.control_of !== "string" || !ID.test(e.control_of))) err(w, "control_of required for a post-fix control");
  });
  for (const [i, e] of entries.entries()) if (e.kind === "post_fix_control" && !ids.has(String(e.control_of))) err(`selection.entries[${i}]`, "control_of names no entry");
  const findings = Array.isArray(gt.findings) ? (gt.findings as Obj[]) : [];
  findings.forEach((f, i) => {
    const w = `ground-truth.findings[${i}]`;
    if (!ids.has(String(f.entry))) err(w, "entry not in selection");
    if (!["high", "medium", "exploit"].includes(String(f.severity))) err(w, "severity");
    if (typeof f.class !== "string" || !CLASSES.test(f.class)) err(w, "class");
    if (typeof f.report_url !== "string" || !f.report_url.startsWith("https://")) err(w, "report_url");
    if (typeof f.mappable !== "boolean") err(w, "mappable");
    if (f.mappable === true && (!Array.isArray(f.locations) || f.locations.length === 0)) err(w, "mappable finding without locations");
    if (f.fix_commit !== null && (typeof f.fix_commit !== "string" || !SHA.test(f.fix_commit))) err(w, "fix_commit");
  });
  const controls = Array.isArray(gt.controls) ? (gt.controls as Obj[]) : [];
  controls.forEach((c, i) => { if (!ids.has(String(c.entry))) err(`ground-truth.controls[${i}]`, "entry not in selection"); });
  const kinds = (k: string) => entries.filter((e) => e.kind === k).length;
  const claimed = new Set(findings.filter((f) => typeof f.class === "string" && !String(f.class).startsWith("other:")).map((f) => String(f.entry)));
  const otherOnly = [...ids].filter((id) => findings.some((f) => f.entry === id) && !claimed.has(id)).length;
  if (claimed.size < 12) err("rules", `entries with claimed-class findings: ${claimed.size} (< 12)`);
  if (otherOnly < 8) err("rules", `entries with only other-class findings: ${otherOnly} (< 8)`);
  if (kinds("post_fix_control") + kinds("clean_control") < Math.ceil(entries.length / 3)) err("rules", "controls fewer than one third of entries");
  return { errors, counts: { entries: entries.length, vulnerable: kinds("vulnerable"), post_fix_controls: kinds("post_fix_control"), clean_controls: kinds("clean_control"),
    findings: findings.length, unmappable: findings.filter((f) => f.mappable === false).length, entries_with_claimed_classes: claimed.size, entries_other_only: otherOnly,
    prior_knowledge_risk: entries.filter((e) => e.prior_knowledge_risk === true).length } };
}

if (process.argv[1] && process.argv[1].endsWith("validate.ts") && process.argv[2]) {
  const r = validate(JSON.parse(readFileSync(process.argv[2], "utf8")), JSON.parse(readFileSync(process.argv[3]!, "utf8")));
  console.log(JSON.stringify({ valid: r.errors.length === 0, counts: r.counts, errors: r.errors }, null, 1));
  process.exit(r.errors.length ? 1 : 0);
}
