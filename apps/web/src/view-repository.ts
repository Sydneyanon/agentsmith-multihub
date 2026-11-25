import { h, mount } from "./dom.js";
import { ApiError } from "./api.js";
import { badge, chip, classLegend, codeBlock, empty, errorState, kv, loadInto, loading, mono, pagerBar, panel, surfaceMap } from "./components.js";
import { bytes, exactTime, plural, shortHash } from "./format.js";
import { link, linkWith } from "./router.js";
import type { Ctx } from "./ctx.js";
import type { FileRow, FileText, Page, SnapshotDetail, SnapshotSummary, Surface } from "./types.js";
import { HYPOTHESIS_STATUS, word } from "./vocab.js";

export function renderRepository(ctx: Ctx, id: string | undefined, query: Record<string, string>): HTMLElement {
  return id ? renderSnapshot(ctx, id, query) : renderSnapshotList(ctx, query);
}

function renderSnapshotList(ctx: Ctx, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  const offset = Number(query["offset"] ?? 0) || 0;
  root.append(h("div", { class: "view-head" }, h("h1", {}, "Repository"), h("p", { class: "muted" }, "Commit-pinned, sealed snapshots of repository content, with the attack-surface map and evidence-cited code.")), body);
  loadInto(body, () => ctx.api.get<Page<SnapshotSummary>>("/v1/research/snapshots", { offset, limit: 25 }), (page) => {
    if (page.items.length === 0) return empty("No repository snapshots", "No repository has been acquired. Acquisition is built in Task 5.2; until then this page has nothing to show and no sample repository is displayed.", "Task 5.2");
    return h("div", {}, h("ul", { class: "rows" }, ...page.items.map((s) => h("li", {}, h("a", { class: "row-link", href: link("repository", s.id) },
      h("span", { class: "row-main" }, h("strong", {}, s.repository), h("span", { class: "muted small" }, `commit ${shortHash(s.commit_sha, 12)} · ${s.file_count ?? "?"} files · ${s.spans} spans · ${plural(s.hypotheses, "hypothesis").replace("hypothesiss", "hypotheses")}`)),
      chip(s.sealed_at ? "sealed" : "building", s.sealed_at ? "green" : "amber"))))),
      pagerBar({ hasMore: page.has_more, offset: page.offset, limit: page.limit, go: (o) => ctx.go(linkWith("#/repository", { offset: o ? String(o) : undefined })) }));
  });
  return root;
}

function renderSnapshot(ctx: Ctx, id: string, query: Record<string, string>): HTMLElement {
  const root = h("div", { class: "view" });
  const body = h("div", {});
  const path = query["path"];
  const prefix = query["prefix"] ?? "";
  root.append(h("p", {}, h("a", { class: "link", href: link("repository") }, "← Snapshots")), body);
  loadInto(body, () => ctx.api.get<SnapshotDetail>(`/v1/research/snapshots/${id}`), (snap) => {
    const verifyBox = h("div", { class: "verify" });
    const verify = h("button", { class: "btn", type: "button", onclick: () => {
      mount(verifyBox, loading("Re-hashing every stored blob"));
      ctx.api.get<SnapshotDetail>(`/v1/research/snapshots/${id}`, { verify: 1 }).then((r) => mount(verifyBox, h("pre", { class: "json" }, JSON.stringify(r.verification, null, 2))), (e: unknown) => mount(verifyBox, errorState(e)));
    } }, "Re-verify stored content");
    const header = panel("Pinned snapshot", [kv([
      ["Repository", snap.repository], ["Host", snap.source_host], ["Commit", mono(snap.commit_sha)], ["Ref", snap.ref_name ?? "—"],
      ["State", snap.sealed ? badge({ label: "Sealed", tone: "green", hint: "Content is immutable and covered by the manifest hash." }) : badge({ label: "Building", tone: "amber", hint: "Not sealed: content may still change." })],
      ["Files", `${snap.files.stored} stored, ${snap.files.skipped} skipped${snap.file_count !== null ? ` (${snap.file_count} in manifest)` : ""}`], ["Size", bytes(snap.total_bytes === null ? null : Number(snap.total_bytes))],
      ["Manifest hash", mono(shortHash(snap.manifest_sha256, 16))], ["Evidence spans", String(snap.spans)], ["Hypotheses", String(snap.hypotheses)], ["Created", exactTime(snap.created_at)],
      ["Project", h("a", { class: "link", href: link("projects", snap.workflow_run_id) }, "open project")],
    ]), h("div", { class: "toolbar" }, verify), verifyBox]);

    const mapBox = h("div", {});
    loadInto(mapBox, () => ctx.api.get<Surface>(`/v1/research/snapshots/${id}/surface`), (surface) => {
      if (surface.files.length === 0) return empty("No files in the manifest", "This snapshot has no file records.");
      return h("div", {}, surfaceMap(surface.files, (p) => ctx.go(linkWith(link("repository", id), { path: p }))), classLegend(),
        h("p", { class: "muted small" }, "Area is file size, colour is classification, a bright outline marks files cited as evidence, and a badge counts hypotheses citing the file.", surface.truncated ? " The map is truncated at 5,000 files." : ""));
    });

    const browser = h("div", { class: "split" }, h("div", { class: "split-side" }, fileList(ctx, id, prefix)), h("div", { class: "split-main" }, path ? fileViewer(ctx, id, path) : empty("Select a file", "Choose a file in the list or the map to read it with its evidence spans.")));
    return h("div", { class: "stack" }, h("div", { class: "view-head" }, h("h1", {}, snap.repository)), header, panel("Attack-surface map", [mapBox]), panel("Files and code", [browser]));
  });
  return root;
}

function fileList(ctx: Ctx, id: string, prefix: string): HTMLElement {
  const box = h("div", {});
  const up = prefix.includes("/") ? prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1) : "";
  loadInto(box, () => ctx.api.get<Page<FileRow>>(`/v1/research/snapshots/${id}/files`, { prefix: prefix || undefined, limit: 500 }), (page) => {
    const dirs = new Set<string>(); const files: FileRow[] = [];
    for (const f of page.items) {
      const rest = f.path.slice(prefix.length); const slash = rest.indexOf("/");
      if (slash >= 0) dirs.add(prefix + rest.slice(0, slash + 1)); else files.push(f);
    }
    if (!dirs.size && !files.length) return empty("No files", "Nothing matches this folder.");
    return h("div", {}, h("p", { class: "crumb" }, mono(prefix || "/")),
      h("ul", { class: "tree" },
        prefix ? h("li", {}, h("a", { class: "tree-item", href: linkWith(link("repository", id), { prefix: up || undefined }) }, "↩ ..")) : null,
        ...[...dirs].map((d) => h("li", {}, h("a", { class: "tree-item tree-dir", href: linkWith(link("repository", id), { prefix: d }) }, `▸ ${d.slice(prefix.length)}`))),
        ...files.map((f) => h("li", {}, f.stored
          ? h("a", { class: "tree-item", href: linkWith(link("repository", id), { path: f.path, prefix: prefix || undefined }) }, f.path.slice(prefix.length), f.span_count ? chip(`${f.span_count}`, "cyan") : null, f.hypothesis_count ? chip(`${f.hypothesis_count} hyp`, "amber") : null)
          : h("span", { class: "tree-item tree-skipped", title: f.skip_reason ?? "skipped" }, f.path.slice(prefix.length), chip(`skipped: ${f.skip_reason ?? "?"}`, "grey"))))),
      page.has_more ? h("p", { class: "muted small" }, "Only the first 500 entries are listed; narrow with a folder.") : null);
  });
  return box;
}

function fileViewer(ctx: Ctx, id: string, path: string): HTMLElement {
  const box = h("div", {});
  const load = () => ctx.api.get<FileText>(`/v1/research/snapshots/${id}/file`, { path });
  load().then((f) => {
    const marked = new Set<number>();
    for (const sp of f.spans) for (let n = sp.line_start; n <= sp.line_end; n += 1) marked.add(n);
    const lines = f.text.split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    mount(box, h("p", {}, mono(f.path), " ", chip(f.classification, "grey"), " ", chip(bytes(f.size_bytes), "grey")),
      f.spans.length ? h("ul", { class: "chips" }, ...f.spans.map((sp) => h("li", {}, h("a", { class: "link", href: link("evidence", sp.id) }, `lines ${sp.line_start}–${sp.line_end}`),
        ...sp.hypotheses.map((hy) => h("a", { href: link("hypotheses", hy.id) }, badge(word(HYPOTHESIS_STATUS, hy.status))))))) : h("p", { class: "muted small" }, "No evidence spans cite this file."),
      codeBlock(lines.map((text, i) => ({ no: i + 1, text, mark: marked.has(i + 1) }))));
  }, (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) mount(box, empty("File was not stored", `Skipped during acquisition (${String((error.body as { reason?: string } | null)?.reason ?? "no reason recorded")}).`));
    else if (error instanceof ApiError && error.status === 410) mount(box, empty("Content evicted", "The stored bytes were removed under the storage policy. Evidence that cites them cannot be re-checked."));
    else if (error instanceof ApiError && error.status === 415) mount(box, empty("Not text", "This file is not valid UTF-8 and is not rendered."));
    else mount(box, errorState(error, () => ctx.go(location.hash)));
  });
  box.append(loading("Loading file"));
  return box;
}
