/**
 * The ONE research run APEX may shadow (owner approval, 2026-11-28, development work): USX, scroll-tech/usx-contracts at commit
 * 9e972566deb59b4d2c499015c2557c5e5f236e3c, limited to the official 20-file scope (docs/research-runs/usx-scope-evidence.md).
 *
 * The shadow stage is MEASUREMENT ONLY: it records where APEX abstains and what it can and cannot model. It never produces a finding,
 * a hypothesis row, an evaluation or a dossier entry (docs/architecture/apex-first-capability.md §10-§11.2).
 *
 * Enablement is per run and explicit only: a run gets the stage only when it is created with `apexShadow` (the targeted promotion's
 * `--apex-shadow`, which records who approved it and the commit). No environment variable turns it on, and every check below is repeated
 * when the stage runs and again when its record is stored, so a run edited after creation is refused with a recorded reason.
 */
export const APEX_SHADOW_STEP_KEY = "apex_shadow";
export const APEX_SHADOW_ROLE = "shadow_explorer";
export const APEX_SHADOW_SCOPE = "repository_research";
/** Bump on any change that can alter what the shadow stage records. */
export const APEX_SHADOW_VERSION = "apex-shadow/1";
export const APEX_SHADOW_LABEL = "APEX shadow: unvalidated, not evidence";

export const APEX_SHADOW_TARGET = {
  programme: "sherlock:273",
  repository: "scroll-tech/usx-contracts",
  commit: "9e972566deb59b4d2c499015c2557c5e5f236e3c",
  /** sha256 of the official scope page as fetched (docs/research-runs/usx-scope-evidence.md) */
  evidenceSha256: "1cdc83533cb8e55f89b57ae3d643cc8b16e1bdd5ea7d6b64492cbf83c19170b3",
  /** the official in-scope selection: 20 files, sorted */
  inScopePaths: [
    "src/BridgedToken.sol",
    "src/StakedUSX.sol",
    "src/TreasuryDiamond.sol",
    "src/TreasuryStorage.sol",
    "src/USX.sol",
    "src/asset-manager/AssetManager.sol",
    "src/facets/AssetManagerAllocatorFacet.sol",
    "src/facets/RewardDistributorFacet.sol",
    "src/interfaces/IAssetManager.sol",
    "src/interfaces/IScrollERC20Bridge.sol",
    "src/interfaces/IStakedUSX.sol",
    "src/interfaces/ITreasury.sol",
    "src/interfaces/IUSX.sol",
    "src/misc/ERC20Relayer.sol",
    "src/mocks/MockAssetManager.sol",
    "src/oft/BridgedTokenOFTAdapter.sol",
    "src/oft/StakedUSXOFT.sol",
    "src/oft/StakedUSXOFTAdaptor.sol",
    "src/oft/USXOFT.sol",
    "src/oft/USXOFTAdaptor.sol",
  ] as readonly string[],
} as const;

export type ApexShadowApproval = { approved_by: string; approved_commit: string; approved_at: string; basis: string };
export type ApexShadowRefusalCode =
  | "not_requested" | "not_the_approved_repository" | "not_the_approved_commit" | "approval_commit_mismatch" | "no_bounty_scope"
  | "not_the_approved_programme" | "scope_paths_differ" | "scope_evidence_differs" | "snapshot_commit_differs" | "snapshot_not_sealed" | "structural_analysis_required";
export class ApexShadowRefused extends Error {
  constructor(readonly code: ApexShadowRefusalCode, message: string) { super(`APEX shadow refused (${code}): ${message}`); this.name = "ApexShadowRefused"; }
}
export type Eligibility = { ok: true } | { ok: false; code: ApexShadowRefusalCode; reason: string };

const sameSet = (a: readonly string[], b: readonly string[]) => { const x = [...new Set(a)].sort(); const y = [...new Set(b)].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };

/**
 * Whether a run (its recorded input) and, when known, its sealed snapshot are the approved USX target. Pure: the caller supplies the
 * records. `scope` is the run's bounty_scope as recorded (unparsed); `approval` is the run's `apex_shadow` record.
 */
export function apexShadowEligibility(run: { repository: unknown; ref: unknown; approval: unknown; scope: unknown }, snapshot?: { commitSha: string; sealed: boolean } | null): Eligibility {
  const T = APEX_SHADOW_TARGET;
  const approval = run.approval as Partial<ApexShadowApproval> | null | undefined;
  if (!approval || typeof approval !== "object" || typeof approval.approved_by !== "string" || !approval.approved_by.trim()) return { ok: false, code: "not_requested", reason: "the run carries no recorded APEX shadow approval (apex_shadow.approved_by)" };
  if (typeof run.repository !== "string" || run.repository.toLowerCase() !== T.repository) return { ok: false, code: "not_the_approved_repository", reason: `the run is for ${String(run.repository)}, not ${T.repository}` };
  if (run.ref !== T.commit) return { ok: false, code: "not_the_approved_commit", reason: `the run is pinned to ${String(run.ref)}, not ${T.commit}` };
  if (approval.approved_commit !== T.commit) return { ok: false, code: "approval_commit_mismatch", reason: `the approval names commit ${String(approval.approved_commit)}, not ${T.commit}` };
  const scope = run.scope as { programme?: unknown; in_scope_paths?: unknown; evidence_sha256?: unknown } | null | undefined;
  if (!scope || typeof scope !== "object") return { ok: false, code: "no_bounty_scope", reason: "the run carries no official bounty scope" };
  if (scope.programme !== T.programme) return { ok: false, code: "not_the_approved_programme", reason: `the scope is of ${String(scope.programme)}, not ${T.programme}` };
  if (!Array.isArray(scope.in_scope_paths) || !sameSet(scope.in_scope_paths.map(String), T.inScopePaths)) {
    const got = Array.isArray(scope.in_scope_paths) ? scope.in_scope_paths.map(String) : [];
    const missing = T.inScopePaths.filter((p) => !got.includes(p)); const extra = got.filter((p) => !T.inScopePaths.includes(p));
    return { ok: false, code: "scope_paths_differ", reason: `the run's in-scope paths are not the official 20 (missing ${missing.length}${missing.length ? `: ${missing.slice(0, 5).join(", ")}` : ""}; extra ${extra.length}${extra.length ? `: ${extra.slice(0, 5).join(", ")}` : ""})` };
  }
  if (scope.evidence_sha256 !== T.evidenceSha256) return { ok: false, code: "scope_evidence_differs", reason: `the scope's evidence hash ${String(scope.evidence_sha256).slice(0, 12)}… is not the official page's ${T.evidenceSha256.slice(0, 12)}…` };
  if (snapshot) {
    if (!snapshot.sealed) return { ok: false, code: "snapshot_not_sealed", reason: "the run's snapshot is not sealed and verified" };
    if (snapshot.commitSha !== T.commit) return { ok: false, code: "snapshot_commit_differs", reason: `the sealed snapshot is of commit ${snapshot.commitSha}, not ${T.commit}` };
  }
  return { ok: true };
}

/**
 * Run creation: refuses (throws ApexShadowRefused) unless the run being created is exactly the approved target. Every other run is
 * created exactly as before, with no `apex_shadow` field and no shadow step.
 */
export function assertApexShadowRequestAllowed(input: { repository: string; ref?: string | undefined }, options: { structuralAnalysis?: boolean; bountyScope?: unknown; approvedBy: string }): void {
  if (options.structuralAnalysis !== true) throw new ApexShadowRefused("structural_analysis_required", "the shadow stage runs after the dossier of a structural-analysis run");
  if (!options.approvedBy.trim()) throw new ApexShadowRefused("not_requested", "an APEX shadow request must name who approved it");
  const e = apexShadowEligibility({ repository: input.repository, ref: input.ref, approval: { approved_by: options.approvedBy, approved_commit: APEX_SHADOW_TARGET.commit }, scope: options.bountyScope });
  if (!e.ok) throw new ApexShadowRefused(e.code, e.reason);
}
