import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { WorkflowWorker, type ClaimedStep } from "./worker.js";
import { resolveSourceReference } from "./source-resolver.js";

type IntakeStepInput = {
  intake_kind?: unknown;
  value?: unknown;
  source?: unknown;
  notes?: unknown;
  source_reference?: unknown;
  execution_mode?: unknown;
  authorization_status?: unknown;
};

export type ProcessResult = { status: "idle" } | { status: "completed"; stepId: string };

/**
 * First deliberately narrow worker slice: normalize and persist intake provenance.
 * It performs no network request, repository clone, scan, transaction or PoC execution.
 */
export async function processIntakeResolution(worker: WorkflowWorker, step: ClaimedStep): Promise<ProcessResult> {
  if (step.step_key !== "resolve_source") {
    throw new Error(`Unsupported step for intake-resolution worker: ${step.step_key}`);
  }
  const input = step.input as IntakeStepInput;
  if (input.execution_mode !== "passive_only" || input.authorization_status !== "unverified") {
    throw new Error("Intake step is missing the required passive-only authorization defaults");
  }
  if (input.intake_kind !== "url" && input.intake_kind !== "idea") {
    throw new Error("Invalid intake_kind in persisted workflow step");
  }
  if (typeof input.value !== "string" || input.value.length < 3 || input.value.length > 4_000) {
    throw new Error("Invalid intake value in persisted workflow step");
  }

  let sourceReference: ReturnType<typeof resolveSourceReference> | null = null;
  if (input.intake_kind === "url") {
    sourceReference = resolveSourceReference(input.value);
    if (input.source_reference && !isDeepStrictEqual(input.source_reference, sourceReference)) {
      throw new Error("Stored source reference does not match deterministic URL resolution");
    }
  }

  await worker.complete(step.id, {
    intake_kind: input.intake_kind,
    submitted_value: input.value,
    source: typeof input.source === "string" ? input.source : "user",
    notes_present: typeof input.notes === "string" && input.notes.length > 0,
    source_reference: sourceReference,
    execution_mode: "passive_only",
    authorization_status: "unverified",
    network_access_performed: false,
    next_step_requires_separate_handler: true,
  });
  return { status: "completed", stepId: step.id };
}

export async function runIntakeWorker(pool: Pool, workerId: string, signal: AbortSignal, pollMs = 2_000): Promise<void> {
  const worker = new WorkflowWorker(pool, workerId);
  while (!signal.aborted) {
    await worker.reapExhaustedLeases();
    const step = await worker.claimNext(["resolve_source"]);
    if (!step) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      continue;
    }
    try {
      await processIntakeResolution(worker, step);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown intake resolution error";
      await worker.fail(step.id, reason, false);
    }
  }
}
