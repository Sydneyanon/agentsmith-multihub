import { clear, h, s, type Child } from "./dom.js";
import { describeError } from "./api.js";
import { squarify } from "./treemap.js";
import { type StageState, type Tone, type Word, HYPOTHESIS_STATUS, word, FILE_CLASS_TONE } from "./vocab.js";
import type { SurfaceFile } from "./types.js";

export const badge = (w: Word, extra?: string): HTMLElement => h("span", { class: `badge tone-${w.tone}`, title: w.hint || null }, w.label, extra ? ` ${extra}` : null);
export const chip = (text: string, tone: Tone = "grey"): HTMLElement => h("span", { class: `badge tone-${tone}` }, text);
export const mono = (text: string): HTMLElement => h("code", { class: "mono" }, text);

export function panel(title: string, body: Child[], opts: { actions?: Child[]; class?: string } = {}): HTMLElement {
  return h("section", { class: `panel ${opts.class ?? ""}`.trim() },
    h("header", { class: "panel-head" }, h("h2", {}, title), opts.actions?.length ? h("div", { class: "panel-actions" }, ...opts.actions) : null),
    h("div", { class: "panel-body" }, ...body));
}

export const loading = (what = "Loading"): HTMLElement => h("div", { class: "state state-loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), ` ${what}…`);

export function empty(title: string, detail: string, producedBy?: string): HTMLElement {
  return h("div", { class: "state state-empty" }, h("span", { class: "state-icon", "aria-hidden": "true" }, "∅"), h("strong", {}, title), h("p", {}, detail), producedBy ? h("p", { class: "muted small" }, `Produced by: ${producedBy}.`) : null);
}

export function errorState(error: unknown, retry?: () => void): HTMLElement {
  const info = describeError(error);
  return h("div", { class: "state state-error", role: "alert" }, h("strong", {}, info.title), h("p", {}, info.detail),
    retry ? h("button", { class: "btn", type: "button", onclick: retry }, "Retry") : null);
}

/** Shows a loading state, then the result of `load`, or an error with retry. Returns a container the caller mounts once. */
export function loadInto<T>(container: HTMLElement, load: () => Promise<T>, render: (data: T) => Node): void {
  const run = () => {
    clear(container); container.append(loading());
    load().then((data) => { clear(container); container.append(render(data)); },
      (error: unknown) => { clear(container); container.append(errorState(error, run)); });
  };
  run();
}

export function statCard(label: string, value: string | number, note: string, tone: Tone = "cyan", icon?: string): HTMLElement {
  return h("div", { class: `stat tone-${tone}` },
    h("div", { class: "stat-top" }, h("span", { class: "stat-label" }, label), icon ? h("span", { class: "stat-icon", "aria-hidden": "true" }, icon) : null),
    h("strong", { class: "stat-value" }, String(value)), h("span", { class: "stat-note" }, note));
}

export function progressBar(done: number, total: number, label: string): HTMLElement {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done, "aria-label": label },
    h("span", { class: "progress-fill", style: `width:${pct}%` }), h("span", { class: "progress-text" }, `${done}/${total} ${label}`));
}

const TONE_VAR: Record<string, string> = { cyan: "var(--cyan)", green: "var(--green)", amber: "var(--amber)", red: "var(--red)", grey: "var(--grey)", violet: "var(--violet)" };

export function stepper(slots: Array<{ key: string; label: string; state: StageState; notBuilt?: string }>): HTMLElement {
  return h("ol", { class: "stepper" }, ...slots.map((slot) => {
    const text = slot.state === "done" ? "Records exist" : slot.state === "not_built" ? `Not built (${slot.notBuilt})` : "No records yet";
    return h("li", { class: `step step-${slot.state}` }, h("span", { class: "step-dot", "aria-hidden": "true" }, slot.state === "done" ? "✓" : ""), h("span", { class: "step-label" }, slot.label), h("span", { class: "step-state" }, text));
  }));
}

/** Donut over backend counts. Colours come from the status vocabulary; the legend carries the numbers, so colour is never the only channel. */
export function donut(counts: Record<string, number>, order: string[], centre: { value: string; label: string }): HTMLElement {
  const entries = order.filter((key) => (counts[key] ?? 0) > 0).map((key) => ({ key, n: counts[key]! }));
  const total = entries.reduce((a, e) => a + e.n, 0);
  const R = 52, C = 2 * Math.PI * R;
  const svg = s("svg", { viewBox: "0 0 140 140", class: "donut", role: "img", "aria-label": `${centre.value} ${centre.label}` });
  svg.append(s("circle", { cx: 70, cy: 70, r: R, fill: "none", stroke: "var(--line)", "stroke-width": 16 }));
  let offset = 0;
  for (const e of entries) {
    const len = (e.n / total) * C;
    svg.append(s("circle", { cx: 70, cy: 70, r: R, fill: "none", stroke: TONE_VAR[word(HYPOTHESIS_STATUS, e.key).tone]!, "stroke-width": 16, "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -offset, transform: "rotate(-90 70 70)" }));
    offset += len;
  }
  svg.append(s("text", { x: 70, y: 70, "text-anchor": "middle", class: "donut-value" }, centre.value), s("text", { x: 70, y: 88, "text-anchor": "middle", class: "donut-label" }, centre.label));
  return h("div", { class: "donut-wrap" }, svg, h("ul", { class: "legend" }, ...entries.map((e) => {
    const w = word(HYPOTHESIS_STATUS, e.key);
    return h("li", {}, h("span", { class: `swatch tone-${w.tone}` }), h("span", {}, w.label), h("strong", {}, String(e.n)));
  })));
}

/** One horizontal stacked bar per key; segments are backend counts per status. */
export function stackedBars(rows: Array<{ label: string; counts: Record<string, number> }>, statusOrder: string[], toneOf: (status: string) => Tone): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => Object.values(r.counts).reduce((a, b) => a + b, 0)));
  return h("div", { class: "bars" }, ...rows.map((row) => {
    const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
    return h("div", { class: "bar-row" }, h("span", { class: "bar-label" }, row.label),
      h("span", { class: "bar-track", role: "img", "aria-label": `${row.label}: ${statusOrder.filter((k) => row.counts[k]).map((k) => `${row.counts[k]} ${k}`).join(", ") || "none"}` },
        ...statusOrder.filter((k) => row.counts[k]).map((k) => h("span", { class: `bar-seg tone-${toneOf(k)}`, style: `width:${(row.counts[k]! / max) * 100}%`, title: `${k}: ${row.counts[k]}` }))),
      h("span", { class: "bar-total" }, String(total)));
  }));
}

export function kv(pairs: Array<[string, Child]>): HTMLElement {
  return h("dl", { class: "kv" }, ...pairs.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

export function codeBlock(lines: Array<{ no: number; text: string; mark?: boolean }>): HTMLElement {
  return h("pre", { class: "code", tabindex: 0 }, ...lines.map((l) => h("span", { class: `code-line${l.mark ? " code-mark" : ""}` }, h("span", { class: "code-no" }, String(l.no)), h("span", { class: "code-text" }, l.text, "\n"))));
}

export const TREEMAP_WIDE = { w: 960, h: 420 };
export const TREEMAP_NARROW = { w: 420, h: 520 };
/** A container narrower than this gets the tall layout so file labels stay legible on a phone. */
export const TREEMAP_NARROW_BELOW = 600;
export const treemapSizeFor = (containerWidth: number): { w: number; h: number } => (containerWidth > 0 && containerWidth < TREEMAP_NARROW_BELOW ? TREEMAP_NARROW : TREEMAP_WIDE);

/**
 * Attack-surface map: squarified treemap, area = file size, colour = classification, outline = cited by evidence.
 * It follows its container: when the width crosses the narrow threshold (window resize, device rotation, split panes) the
 * map is laid out again for the new shape. Without ResizeObserver it uses the window width once.
 */
export function surfaceMap(files: SurfaceFile[], onSelect: (path: string) => void): HTMLElement {
  const wrap = h("div", { class: "treemap-wrap" });
  let current: { w: number; h: number } | null = null;
  const draw = (width: number) => {
    const size = treemapSizeFor(width);
    if (size === current) return;
    current = size;
    clear(wrap);
    wrap.append(treemapSvg(files, onSelect, size));
  };
  draw(typeof window !== "undefined" ? window.innerWidth : TREEMAP_WIDE.w);
  if (typeof ResizeObserver !== "undefined") {
    let attached = false;
    const observer = new ResizeObserver((entries) => {
      // Once the map has been shown and then removed from the page (route change, re-render), stop observing so nothing keeps it alive.
      if (wrap.isConnected) attached = true;
      else if (attached) { observer.disconnect(); return; }
      const width = entries[0]?.contentRect.width;
      if (width) draw(width);
    });
    observer.observe(wrap);
  }
  return wrap;
}

function treemapSvg(files: SurfaceFile[], onSelect: (path: string) => void, size: { w: number; h: number }): SVGElement {
  const stored = files.filter((f) => f.stored && f.size_bytes > 0);
  const rects = squarify(stored.map((f) => ({ weight: f.size_bytes, data: f })), size.w, size.h);
  const svg = s("svg", { viewBox: `0 0 ${size.w} ${size.h}`, class: "treemap", role: "group", "aria-label": "Attack-surface map: stored files by size and classification" });
  for (const r of rects) {
    const f = r.data;
    const hypCount = Object.values(f.hypotheses_by_status).reduce((a, b) => a + b, 0);
    const g = s("g", { class: "tm-cell", tabindex: 0, role: "button", "aria-label": `${f.path}, ${f.size_bytes} bytes, ${f.classification}, ${f.spans} evidence spans, ${hypCount} hypotheses`,
      onclick: () => onSelect(f.path), onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter") onSelect(f.path); } });
    g.append(s("title", {}, `${f.path}\n${f.size_bytes} B · ${f.classification} · ${f.spans} spans · ${hypCount} hypotheses`));
    g.append(s("rect", { x: r.x + 1, y: r.y + 1, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2), class: `tm-rect tone-${FILE_CLASS_TONE[f.classification] ?? "grey"}${f.spans > 0 ? " tm-cited" : ""}` }));
    const badgeRoom = hypCount > 0 ? 28 : 0;
    if (r.w > 70 + badgeRoom && r.h > 22) g.append(s("text", { x: r.x + 6, y: r.y + 16, class: "tm-text" }, (f.path.split("/").pop() ?? f.path).slice(0, Math.floor((r.w - badgeRoom) / 7))));
    if (hypCount > 0 && r.w > 28 && r.h > 28) g.append(s("circle", { cx: r.x + r.w - 12, cy: r.y + 12, r: 7, class: "tm-hyp" }), s("text", { x: r.x + r.w - 12, y: r.y + 15, "text-anchor": "middle", class: "tm-hyp-n" }, String(hypCount)));
    svg.append(g);
  }
  return svg;
}

export function classLegend(): HTMLElement {
  return h("ul", { class: "legend legend-inline" }, ...Object.entries(FILE_CLASS_TONE).map(([k, t]) => h("li", {}, h("span", { class: `swatch tone-${t}` }), k)));
}

export function pagerBar(opts: { hasMore: boolean; offset: number; limit: number; go: (offset: number) => void }): HTMLElement | null {
  if (!opts.hasMore && opts.offset === 0) return null;
  return h("div", { class: "pager" },
    h("button", { class: "btn", type: "button", disabled: opts.offset === 0, onclick: () => opts.go(Math.max(0, opts.offset - opts.limit)) }, "Previous"),
    h("span", { class: "muted small" }, `${opts.offset + 1}–${opts.offset + opts.limit}`),
    h("button", { class: "btn", type: "button", disabled: !opts.hasMore, onclick: () => opts.go(opts.offset + opts.limit) }, "Next"));
}
