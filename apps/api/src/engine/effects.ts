import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Dry-run side-effect guard (T-199 hardening). A database rollback is not enough: a stage previewed in dry run must also be unable
 * to reach the network, start a subprocess or write a file. Every such point in the engine calls `assertSideEffectAllowed`
 * (outbound fetch, the tool runners' spawn and their working-directory writes). Inside `withDryRun` each of them throws
 * DryRunViolation, so a preview that tried would fail loudly instead of acting. Outside a dry run this is a no-op.
 */
export type SideEffect = "network" | "subprocess" | "filesystem";
export class DryRunViolation extends Error {
  constructor(readonly effect: SideEffect, readonly what: string) { super(`dry run: refused ${effect} side effect (${what})`); this.name = "DryRunViolation"; }
}
const scope = new AsyncLocalStorage<{ dryRun: true; attempts: Array<{ effect: SideEffect; what: string }> }>();

export function withDryRun<T>(fn: () => Promise<T>): { result: Promise<T>; attempts: Array<{ effect: SideEffect; what: string }> } {
  const state = { dryRun: true as const, attempts: [] as Array<{ effect: SideEffect; what: string }> };
  return { result: scope.run(state, async () => fn()), attempts: state.attempts }; // a synchronous refusal becomes a rejection
}
export const inDryRun = (): boolean => scope.getStore()?.dryRun === true;
export function assertSideEffectAllowed(effect: SideEffect, what: string): void {
  const s = scope.getStore();
  if (!s) return;
  s.attempts.push({ effect, what });
  throw new DryRunViolation(effect, what);
}
