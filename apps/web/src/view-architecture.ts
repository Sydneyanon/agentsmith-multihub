import { h } from "./dom.js";
import { badge, chip, empty, loadInto, mono } from "./components.js";
import { shortHash } from "./format.js";
import type { Ctx } from "./ctx.js";
import type { ArchitectureSection, DossierBrief } from "./types.js";

/**
 * The P1–P3 protocol architecture of one snapshot, rendered from the dossier endpoint, which builds it ONLY from the protocol model
 * the analysis step stored (re-hashed on read). A check is described, never certified; "open" means no caller-side check was found.
 */
const list = (title: string, items: string[], tone: "amber" | "red" | "grey" | "cyan" = "grey") => items.length
  ? h("div", { class: "arch-list" }, h("h5", {}, title, " ", chip(String(items.length), tone)), h("ul", {}, ...items.slice(0, 30).map((x) => h("li", { class: "mono-wrap small" }, x)), items.length > 30 ? h("li", { class: "muted small" }, `… ${items.length - 30} more`) : null))
  : null;

export function architectureBody(a: ArchitectureSection): HTMLElement {
  if (!a.available) return empty("No protocol model for this snapshot", `${a.reason}. Structural analysis runs only when a worker has the structural switch on.`);
  const entries = a.components.reduce((n, c) => n + c.entry_points.length, 0);
  const open = a.components.reduce((n, c) => n + (c.authority?.open_authority_writes.length ?? 0), 0);
  return h("div", { class: "stack" },
    h("p", { class: "muted small" }, `Model `, mono(shortHash(a.model_sha256, 16)), ` (${a.builder}). ${a.components.length} deployable components, ${entries} entry points, ${open} open authority writes (facts of the code, not findings), ${a.unknowns.length} things not modelled.`),
    ...a.components.map((c) => h("details", { class: "arch-component" },
      h("summary", {}, h("strong", {}, c.id), " ", h("span", { class: "muted small" }, `${c.file}:${c.lines} · ${c.entry_points.length} entry points`),
        (c.authority?.open_authority_writes.length ?? 0) > 0 ? chip(`${c.authority!.open_authority_writes.length} open authority writes`, "amber") : null),
      c.authority && c.authority.roles.length ? h("div", { class: "arch-list" }, h("h5", {}, "Authority (P3)"), h("ul", {}, ...c.authority.roles.map((r) => h("li", { class: "small" },
        mono(r.variable), ` · ${r.strength} · holder ${r.holder}${r.held_by ? ` (${r.held_by})` : ""} · transfer ${r.transfer}`)))) : null,
      list("Open authority writes", c.authority?.open_authority_writes ?? [], "amber"),
      list("Callee-side checks (do not guard the caller)", c.authority?.callee_side_checks ?? []),
      list("Factory / cross-contract paths", c.authority?.factory_paths ?? [], "cyan"),
      list("Proxy boundaries", c.authority?.proxy ?? []), list("Initialisers", c.authority?.initialisers ?? []),
      list("Assumptions", c.authority?.assumptions ?? []), list("Unresolved", c.authority?.unresolved ?? [], "red"),
      c.state_roles.length ? h("div", { class: "arch-list" }, h("h5", {}, "State-variable roles (P2)"), h("ul", {}, ...c.state_roles.map((v) => h("li", { class: "small" }, mono(v.variable), ` · ${v.status}`, v.roles.length ? h("span", { class: "muted mono-wrap" }, ` · ${v.roles.join("; ")}`) : null)))) : null,
      h("div", { class: "arch-list" }, h("h5", {}, "Entry points (P1)"), h("ul", {}, ...c.entry_points.map((e) => h("li", { class: "small" }, mono(e.fn), " ",
        badge(e.guarded ? { label: "caller-side check", tone: "green", hint: "A check on who calls this function runs in this contract." } : { label: "no caller-side check", tone: "grey", hint: "No authorising check on the caller was found; many functions are meant to be open." }),
        e.writes.length ? h("span", { class: "muted" }, ` writes ${e.writes.join(", ")}`) : null,
        e.external_calls.length ? h("span", { class: "muted" }, ` · calls ${e.external_calls.map((x) => `${x.kind} ${x.to}${x.resolved_callee ? ` → ${x.resolved_callee}` : ""}`).join(", ")}`) : null)))))),
    list("Not modelled", a.unknowns.map((u) => `${u.at} ${u.what}`)));
}

export function architecturePanel(ctx: Ctx, snapshotId: string): HTMLElement {
  const box = h("div", {});
  loadInto(box, () => ctx.api.get<DossierBrief>(`/v1/research/snapshots/${snapshotId}/dossier`), (d) => d?.architecture ? architectureBody(d.architecture) : empty("Architecture unavailable", "The backend returned no architecture section for this snapshot."));
  return box;
}
