import { clear, h } from "./dom.js";
import { describeError } from "./api.js";
import { errorState, loading } from "./components.js";
import { exactTime, relativeTime } from "./format.js";

export const REFRESH_MS = 15_000;

/**
 * Live panel: loads, renders, then refreshes in place every `intervalMs` while the tab is visible. The freshness line always says
 * when the server computed what is shown. A failed refresh keeps the last good view but replaces "live" with "stale since …",
 * so old data is never presented as current. Stops by itself once the element leaves the page.
 */
export function livePanel<T>(load: () => Promise<T>, render: (data: T) => Node, opts: { intervalMs?: number; generatedAt?: (data: T) => string | null; now?: () => Date } = {}): HTMLElement {
  const intervalMs = opts.intervalMs ?? REFRESH_MS;
  const now = opts.now ?? (() => new Date());
  const body = h("div", { class: "live-body" });
  const fresh = h("p", { class: "freshness muted small", role: "status", "aria-live": "polite" });
  const root = h("div", { class: "live" }, fresh, body);
  let lastGood: { at: Date; generated: string | null } | null = null;
  let failingSince: Date | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const stamp = () => {
    clear(fresh);
    if (!lastGood) return;
    const age = now().getTime() - lastGood.at.getTime();
    const stale = failingSince !== null || age > 2 * intervalMs;
    fresh.className = `freshness small ${stale ? "is-stale" : "is-live"}`;
    fresh.append(h("span", { class: "live-dot", "aria-hidden": "true" }),
      stale ? `Stale since ${exactTime((failingSince ?? lastGood.at).toISOString())}: showing data the server computed at ${exactTime(lastGood.generated)}.`
        : `Live: refreshed ${relativeTime(lastGood.at.toISOString(), now())}; server time ${exactTime(lastGood.generated)}; refreshes every ${Math.round(intervalMs / 1000)} s while this tab is open.`);
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(tick, intervalMs); };
  const tick = () => {
    if (started && !root.isConnected) { if (timer) clearTimeout(timer); return; } // the view was replaced: stop polling
    if (root.isConnected) started = true;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") { schedule(); return; }
    load().then((data) => {
      const node = render(data); // a render error falls through to the error branch below, like a failed load
      failingSince = null; lastGood = { at: now(), generated: opts.generatedAt?.(data) ?? null };
      clear(body); body.append(node); stamp(); schedule();
    }).catch((error: unknown) => {
      if (!lastGood) { clear(body); body.append(errorState(error, tick)); }
      else { failingSince ??= now(); stamp(); fresh.append(h("span", { class: "muted" }, ` Last refresh failed: ${describeError(error).title}.`)); }
      schedule();
    });
  };
  body.append(loading());
  tick();
  if (typeof document !== "undefined") {
    const onVisible = () => {
      if (started && !root.isConnected) { document.removeEventListener("visibilitychange", onVisible); return; }
      if (document.visibilityState === "visible" && root.isConnected) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
  }
  return root;
}
