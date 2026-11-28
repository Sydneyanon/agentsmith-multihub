/**
 * LOCAL rehearsal of C1 (one shared protocol model, read by hash), C2 (shared lead identity) and C3 (dependency acquisition) on REAL
 * records of a DISPOSABLE database (never production), with controlled, self-authored fixtures:
 *
 *   acquire_repository -> acquire_dependencies -> analyze_structure -> slither_scan -> challenge_leads -> build_dossier -> apex_shadow
 *
 * Nothing is fetched from the network: a loopback GitHub stand-in serves local git repositories to the production GitHubSource. Slither is
 * a STAND-IN printing authored output (labelled in the record). APEX is the unchanged engine, eligible only because the fixture is served
 * as the approved repository, commit and scope; the production eligibility check is not changed. No model is called, no tool is installed.
 *
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres npx tsx scripts/c1-c3-rehearsal.ts [outDir]
 *
 * Prints the record of the run and saves it: <outDir>/c1-c3-rehearsal-record.json (everything, read back from the database),
 * c1-c3-rehearsal-summary.txt (what is printed) and c1-c3-rehearsal-dossier.md (the dossier of the main run).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runC1C3Demonstration, type DemoRecord } from "../apps/api/src/integration/c1c3-demo.js";
import { migratedTestDatabase } from "../apps/api/src/integration/harness.js";

process.env.NODE_ENV = "test"; // the loopback stand-in for GitHub is refused outside the test environment
if (!process.env.TEST_DATABASE_URL) { console.error("TEST_DATABASE_URL is required (a loopback Postgres; the rehearsal creates and drops its own database)"); process.exit(2); }
const outDir = resolve(process.argv[2] ?? "docs/research-runs/c1-c3-rehearsal");
mkdirSync(outDir, { recursive: true });

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 16)}…` : "none");

function print(r: DemoRecord): void {
  say("C1-C3 REHEARSAL (controlled fixtures, disposable database)");
  say(`fixtures: ${r.fixtures}`); say(`slither:  ${r.slither}`); say(`apex:     ${r.apex}`);
  say(`run ${r.run.id}: ${r.run.repository}@${r.run.commit} -> ${r.run.status}`);
  for (const s of r.run.steps) say(`  ${s.sequence} ${s.step.padEnd(22)} ${s.status.padEnd(10)} ${s.result ?? ""}`);

  say(); say("1. THE SHARED PROTOCOL MODEL (built once, by structural analysis)");
  say(`   sha256 ${r.shared_model.sha256}`); say(`   base (P1-P3, unchanged) ${r.shared_model.base_sha256}`); say(`   schema ${r.shared_model.schema}`);
  for (const [k, v] of Object.entries(r.shared_model.sections)) say(`   ${k.padEnd(22)} ${v}`);
  say(`   facts: ${Object.entries(r.shared_model.facts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  for (const n of r.shared_model.not_computed) say(`   NOT COMPUTED ${n.section}: ${n.reason}`);
  say(`   example fact (state): ${JSON.stringify(r.shared_model.example_facts["state"])}`);

  say(); say("2-3. THE MODEL HASH EACH ENGINE READ");
  for (const [who, m] of Object.entries(r.model_hash_read_by)) say(`   ${who.padEnd(42)} ${m.sha256 ?? "none"}  (${m.read})${m.detail ? ` ${JSON.stringify(m.detail)}` : ""}`);
  say(`   all consumers read the same model: ${r.all_consumers_read_the_same_model}`);
  say(`   slither stand-in: remappings passed ${JSON.stringify(r.slither_stage.remappings_passed)}; ${r.slither_stage.dependency_files} dependency source file(s) written; dependency source on disk: ${r.slither_stage.dependency_source_on_disk}`);
  say(`   slither stand-in arguments: ${r.slither_stage.arguments_seen[0] ?? "none"}`);
  say(`   apex shadow: ${r.apex_shadow.status}; label "${r.apex_shadow.label}"; report ${short(r.apex_shadow.report_sha256)}; hypotheses written by APEX: ${r.apex_shadow.hypotheses_written}`);

  const inv = (title: string, i: DemoRecord["shared_hypothesis"]) => {
    say(); say(title);
    if (!i) { say("   (none)"); return; }
    say(`   lead key ${i.lead_key}`); say(`   anchor ${JSON.stringify(i.anchor)}`);
    say(`   ${i.contributions.length} hypotheses, ONE investigation; generator families ${i.generator_families.join(" + ")}; independent generation: ${i.independent_generation}; assessment: ${i.assessment}`);
    for (const c of i.contributions) {
      say(`   - generator ${c.generator} | family ${c.analysis_family} | step ${c.produced_by_step} | hypothesis ${c.hypothesis_id}`);
      say(`       cites ${c.evidence.map((e) => `${e.path}:${e.lines} (${e.role})`).join(", ")}`);
      for (const e of c.evaluations) say(`       evaluated by ${e.evaluator} | family ${e.analysis_family} | ${e.outcome} | ${e.relation} to its generator, ${e.relation_to_investigation} to the investigation`);
    }
    say(`   corroboration: ${JSON.stringify(i.corroboration)}`);
    for (const c of i.contradictions) say(`   CONTRADICTION ${c.kind} (${c.families}): ${c.for.engine} (${c.for.analysis_family}) ${c.for.stance}  <->  ${c.against.engine} (${c.against.analysis_family}) ${c.against.stance}`);
  };
  inv("4-5. ONE SHARED HYPOTHESIS, TWO ENGINES, EVIDENCE KEPT APART", r.shared_hypothesis);
  inv("5. THE CONTRADICTION CASE (both sides kept)", r.contradiction_case);
  say(`   dossier: ${r.dossier.entries} hypotheses listed, counted as ${r.dossier.investigations} investigations (step output: leads=${r.dossier.step_output_leads}, hypotheses=${r.dossier.step_output_hypotheses})`);
  say(`   independence (0016, unchanged): ${r.independence.self_evaluation_refused}`);

  say(); say("6. LIMITATION RECORDS");
  say(`   dependency manifest digest ${r.dependencies.digest} (blob ${short(r.dependencies.blob_sha256)})`);
  for (const d of r.dependencies.records) say(`   ${d.path.padEnd(40)} ${d.status.padEnd(22)} pin ${d.pinned_commit ? `${d.pinned_commit.slice(0, 12)}… (${d.pin_established_by})` : "NONE"}${d.status === "acquired" ? ` tree ${d.tree_sha!.slice(0, 12)}… manifest ${short(d.manifest_sha256)}` : ""}`);
  for (const l of r.dependencies.limitations) say(`   LIMITATION ${l.code} [${l.subject}]: ${l.reason}`);
  for (const p of r.dependencies.packages) say(`   package ${p.name}: ${p.status}${p.pin_established_by ? ` (${p.pin_established_by}, ${p.version})` : ""}`);
  const u = r.unsupported_features;
  say(`   unsupported features, predicted by the model (${u.predicted.epistemic}): ${JSON.stringify(u.predicted.by_feature)}`);
  if (u.gate.status === "computed") { say(`   unsupported features, observed by APEX's fidelity gate (${u.gate.provenance.reported_by}-reported, report ${short(u.gate.provenance.report_sha256)}): ${JSON.stringify(u.gate.by_feature)}`);
    say(`   prediction vs gate: both ${JSON.stringify(u.gate.predicted_and_observed)}; gate only ${JSON.stringify(u.gate.observed_not_predicted)}; predicted only ${JSON.stringify(u.gate.predicted_not_observed)}`);
    for (const a of u.gate.abstentions.slice(0, 3)) say(`   APEX ABSTAINED ${a.feature} at ${a.at} (${a.contract}.${a.function}): ${a.why.slice(0, 140)}`); }
  else say(`   fidelity gate: NOT COMPUTED: ${u.gate.reason}`);
  if (r.blocked_run) { say(`   second project (${r.blocked_run.repository}): slither ${r.blocked_run.slither_status}: ${JSON.stringify(r.blocked_run.abstention)}`);
    for (const i of r.blocked_run.unresolved_imports) say(`   UNRESOLVED IMPORT ${i.path}: ${i.reason}`); say(`   its dossier coverage: ${r.blocked_run.dossier_coverage_status}`); }

  say(); say("REPRODUCIBILITY AND IDENTITY ACROSS SNAPSHOTS");
  say(`   second run of the same parent commit: ${JSON.stringify(r.reproducibility)}`);
  if (r.cross_snapshot) { say(`   lead ${short(r.cross_snapshot.lead_key)} occurs at: ${r.cross_snapshot.occurrences.map((o) => `${o.commit_sha.slice(0, 8)} by ${o.generator}`).join("; ")}`); say(`   ${r.cross_snapshot.note}`); }
}

const db = await migratedTestDatabase();
try {
  const { record, dossierMarkdown } = await runC1C3Demonstration(db);
  print(record);
  writeFileSync(join(outDir, "c1-c3-rehearsal-record.json"), JSON.stringify(record, null, 2) + "\n");
  writeFileSync(join(outDir, "c1-c3-rehearsal-summary.txt"), lines.join("\n") + "\n");
  writeFileSync(join(outDir, "c1-c3-rehearsal-dossier.md"), dossierMarkdown);
  console.log(`\nsaved to ${outDir}: c1-c3-rehearsal-record.json, c1-c3-rehearsal-summary.txt, c1-c3-rehearsal-dossier.md`);
} finally { await db.drop(); }
