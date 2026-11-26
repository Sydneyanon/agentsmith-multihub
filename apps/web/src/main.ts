import { clear, h } from "./dom.js";
import { createApi, describeError, type Api } from "./api.js";
import { clearToken, getToken, setToken } from "./session.js";
import { parseHash, type Route } from "./router.js";
import { NAV } from "./vocab.js";
import { empty } from "./components.js";
import type { Ctx } from "./ctx.js";
import { renderHome } from "./view-home.js";
import { renderProjects } from "./view-projects.js";
import { renderRepository } from "./view-repository.js";
import { renderHypotheses } from "./view-hypotheses.js";
import { renderEvidence } from "./view-evidence.js";
import { renderActivity } from "./view-activity.js";
import { ENGINE_STATE, renderControl } from "./view-control.js";
import { REFRESH_MS } from "./live.js";
import type { EngineStatus } from "./types.js";
import { word } from "./vocab.js";

const NAV_ICON: Record<string, string> = { control: "◉", home: "◈", projects: "▤", repository: "⌥", hypotheses: "✦", evidence: "▣", activity: "≋", reviews: "◐", findings: "⚑", knowledge: "❖", system: "⚙" };

function brand(): HTMLElement {
  return h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "A"), h("span", { class: "brand-text" }, h("strong", {}, "AgentSmith"), h("span", {}, "MultiHub")));
}

export function unlockScreen(onUnlock: (token: string) => void, note?: string): HTMLElement {
  const input = h("input", { id: "token", type: "password", autocomplete: "off", required: true, "aria-describedby": "token-help" });
  return h("main", { class: "unlock" }, h("form", { class: "unlock-card", onsubmit: (e: Event) => { e.preventDefault(); if (input.value.trim()) onUnlock(input.value.trim()); } },
    brand(), h("h1", {}, "Private research hub"), note ? h("p", { class: "callout callout-warn", role: "alert" }, note) : null,
    h("label", { for: "token" }, "Access token"), input,
    h("p", { id: "token-help", class: "muted small" }, "The token is kept in this tab only and is sent to this server as a bearer token. It is never placed in a URL."),
    h("button", { class: "btn btn-primary", type: "submit" }, "Unlock")));
}

function shell(route: Route, content: HTMLElement, lock: () => void, healthChip: HTMLElement): HTMLElement {
  const activeId = route.name === "later" ? route.sub : route.name;
  const item = (n: (typeof NAV)[number], compact: boolean) => n.later
    ? h("span", { class: "nav-item nav-later", title: `Built in ${n.later}` }, h("span", { class: "nav-icon", "aria-hidden": "true" }, NAV_ICON[n.id]), h("span", {}, n.label), compact ? null : h("small", {}, n.later))
    : h("a", { class: `nav-item${activeId === n.id ? " is-active" : ""}`, href: n.hash, "aria-current": activeId === n.id ? "page" : null }, h("span", { class: "nav-icon", "aria-hidden": "true" }, NAV_ICON[n.id]), h("span", {}, compact ? (n.short ?? n.label) : n.label));
  return h("div", { class: "app" },
    h("nav", { class: "sidebar", "aria-label": "Primary" }, brand(), h("ul", {}, ...NAV.map((n) => h("li", {}, item(n, false))))),
    h("div", { class: "main" },
      h("header", { class: "topbar" }, h("span", { class: "workspace" }, "Private research workspace"), healthChip, h("button", { class: "btn btn-quiet", type: "button", onclick: lock, "aria-label": "Lock the hub" }, "Lock")),
      h("main", { id: "content", class: "content" }, content)),
    h("nav", { class: "tabbar", "aria-label": "Primary (mobile)" }, ...NAV.filter((n) => !n.later).map((n) => item(n, true))));
}

function laterView(sub: string | undefined): HTMLElement {
  const n = NAV.find((x) => x.id === sub);
  return h("div", { class: "view" }, h("div", { class: "view-head" }, h("h1", {}, n?.label ?? "Not available")),
    empty(`${n?.label ?? "This section"} is not built`, `It depends on ${n?.later ?? "later work"} and has no backend yet. Nothing is shown rather than placeholder content.`, n?.later));
}

export function renderRoute(ctx: Ctx, route: Route): HTMLElement {
  switch (route.name) {
    case "control": return renderControl(ctx);
    case "home": return renderHome(ctx);
    case "projects": return renderProjects(ctx, route.id, route.query);
    case "repository": return renderRepository(ctx, route.id, route.query);
    case "hypotheses": return renderHypotheses(ctx, route.id, route.query);
    case "evidence": return renderEvidence(ctx, route.id, route.query);
    case "activity": return renderActivity(ctx, route.query);
    default: return laterView(route.sub);
  }
}

/** The top-bar engine chip: engine state from GET /v1/engine/status, refreshed while visible; stops when the chip leaves the page. */
async function healthChip(api: Api): Promise<HTMLElement> {
  const el = h("a", { class: "health-chip tone-grey", href: "#/control" }, "Engine: checking…");
  let seen = false;
  const refresh = () => {
    if (seen && !el.isConnected) return;
    if (el.isConnected) seen = true;
    if (document.visibilityState !== "hidden") api.get<EngineStatus>("/v1/engine/status").then((s) => {
      if (!s?.engine) { el.className = "health-chip tone-grey"; el.textContent = "Engine: status unrecognised"; return; }
      const w = word(ENGINE_STATE, s.engine.state);
      el.className = `health-chip tone-${w.tone}`;
      el.textContent = `Engine: ${w.label.toLowerCase()}${s.data_kind === "synthetic" ? " · SYNTHETIC" : ""}`;
      el.title = `Server time ${s.generated_at}`;
    }, (e: unknown) => { el.className = "health-chip tone-amber"; el.textContent = `Engine: ${describeError(e).title}`; });
    setTimeout(refresh, REFRESH_MS);
  };
  refresh();
  return el;
}

export function boot(root: HTMLElement): void {
  let unlockNote: string | undefined;
  const api = createApi({ getToken, onUnauthorized: () => { clearToken(); unlockNote = "The access token was rejected. Enter it again."; draw(); } });
  const ctx: Ctx = { api, go: (hash) => { if (location.hash === hash) draw(); else location.hash = hash; } };
  function draw(): void {
    clear(root);
    if (!getToken()) { root.append(unlockScreen((t) => { setToken(t); unlockNote = undefined; draw(); }, unlockNote)); return; }
    const route = parseHash(location.hash);
    void healthChip(api).then((chipEl) => {
      clear(root);
      root.append(shell(route, renderRoute(ctx, route), () => { clearToken(); unlockNote = undefined; draw(); }, chipEl));
      document.title = `${NAV.find((n) => n.id === (route.name === "later" ? route.sub : route.name))?.label ?? "Hub"} · AgentSmith MultiHub`;
      window.scrollTo(0, 0);
    });
  }
  window.addEventListener("hashchange", draw);
  draw();
}

const mountPoint = typeof document !== "undefined" ? document.getElementById("app") : null;
if (mountPoint) boot(mountPoint);
