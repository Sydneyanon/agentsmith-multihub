import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { ADAPTERS } from "./adapters.js";
import { canonicalFromUrl, normaliseUrl } from "./canonical.js";
import { runCollection } from "./collect.js";
import { classifyXUrl, extractOpportunities, htmlToDocument, parseOembed, type TextDocument } from "./extract.js";
import { assertPublicHttpUrl, checkRobots, type HttpGet } from "./http.js";
import { recomputeProgram, upsertObservation } from "./store.js";
import { BountyError, emptyOpportunity, type ExtractedOpportunity } from "./types.js";

/**
 * Manual import of one URL, or pasted text with its original URL. One input can yield several opportunities. The report says
 * exactly what happened; a page that could not be retrieved is a failed import, never "0 found".
 * Safety: the URL is untrusted. It goes through the URL checks and the SSRF-guarded transport, robots.txt is honoured, the body is
 * capped (2 MB) and timed (30 s), nothing downloaded is executed, links are not followed recursively, and an import never
 * triggers another import. Recognised platform links are resolved through the platform's own collection adapter (at most one
 * listing fetch per platform per import) when that source is enabled, never by scraping the programme page.
 */
export type ImportInput = { url?: string | null; text?: string | null; kind?: "x_thread" | "x_post" | null; submittedBy: string };
export type ImportItem = { programId: string; project: string; outcome: string; matchBasis: string; verification: string; status: string; maxReward: unknown; officialUrl: unknown };
export type ImportReport = {
  importId: string; status: "succeeded" | "partial" | "failed" | "blocked"; urlKind: string; retrieved: boolean; retrieval: string;
  discovered: number; added: number; matched: number; updated: number; needsVerification: number; items: ImportItem[];
  limitations: string[]; unresolvedLinks: string[]; ignoredSegments: number;
};

const MAX_TEXT = 50_000;
const SOURCE_FOR_PLATFORM: Record<string, string> = { sherlock: "sherlock", hackenproof: "hackenproof", immunefi: "immunefi", cantina: "cantina" };

export async function runImport(pool: Pool, http: HttpGet, input: ImportInput, now = () => new Date()): Promise<ImportReport> {
  const text = input.text?.trim() ? input.text.trim() : null;
  const rawUrl = input.url?.trim() ? input.url.trim().replace(/^http:\/\//i, "https://") : null;
  if (!text && !rawUrl) throw new BountyError("invalid_request", "give a URL, pasted text, or both");
  if (text && text.length > MAX_TEXT) throw new BountyError("text_too_long", `pasted text is limited to ${MAX_TEXT} characters`);
  let url: string | null = null;
  if (rawUrl) { assertPublicHttpUrl(rawUrl); url = normaliseUrl(rawUrl); if (!url) throw new BountyError("invalid_url", "not a valid http(s) URL"); }
  const x = url ? classifyXUrl(url) : null;
  const canonical = url ? canonicalFromUrl(url) : null;
  const host = url ? new URL(url).hostname : null;
  const urlKind = text ? (x ? (input.kind ?? (x.kind === "x_profile" ? "x_profile" : "x_post")) : "text_only")
    : x ? x.kind : canonical ? "platform_programme" : host === "bug-bounty-board.vercel.app" ? "community_listing" : "web_page";

  const imp = await pool.query<{ id: string }>("INSERT INTO bounty_imports (submitted_url, submitted_text, url_kind, submitted_by, submitted_at) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [url, text, urlKind, input.submittedBy, now()]);
  const importId = imp.rows[0]!.id;
  const report: ImportReport = { importId, status: "succeeded", urlKind, retrieved: false, retrieval: "", discovered: 0, added: 0, matched: 0, updated: 0, needsVerification: 0, items: [], limitations: [], unresolvedLinks: [], ignoredSegments: 0 };
  const done = async () => {
    await pool.query("UPDATE bounty_imports SET status = $2, report = $3, extracted_at = $4, fetched_at = CASE WHEN $5 THEN $4 ELSE fetched_at END WHERE id = $1",
      [importId, report.status, JSON.stringify(report), now(), report.retrieved]);
    return report;
  };

  try {
    let doc: TextDocument | null = null; let sourceKey = "web-import"; let refBase = url ?? `text:${createHash("sha256").update(text!).digest("hex").slice(0, 16)}`;
    const sourcesEnabled = new Map((await pool.query<{ source_key: string; enabled: boolean; access_status: string }>("SELECT source_key, enabled, access_status FROM bounty_sources")).rows.map((r) => [r.source_key, r]));

    if (text) {
      // Pasted text: nothing is fetched. X text keeps X attribution (authority of a social post).
      sourceKey = x ? "x" : "text-import"; report.retrieval = "pasted text; nothing was fetched"; report.retrieved = true;
      doc = { text, links: [], baseUrl: url, author: x ? `@${x.handle}` : null, publishedAt: null, title: null };
      if (x?.kind === "x_profile") report.limitations.push("pasted from an X profile: each opportunity is attributed to the profile URL, not to an individual post");
    } else if (x) {
      sourceKey = "x";
      const xs = sourcesEnabled.get("x");
      if (x.kind === "x_profile") {
        report.status = "blocked"; report.retrieval = "not retrieved";
        report.limitations.push("X profiles cannot be read without the paid X API, and x.com robots.txt disallows crawling. Paste the posts' text together with the profile URL.");
        return await done();
      }
      if (!xs?.enabled) {
        report.status = "blocked"; report.retrieval = "not retrieved";
        report.limitations.push("Retrieving X posts is off: x.com and publish.x.com/oembed are disallowed by robots.txt, and enabling the oEmbed path is an owner decision. Paste the post or thread text together with this URL.");
        return await done();
      }
      const oembedUrl = `https://publish.x.com/oembed?url=${encodeURIComponent(x.url)}&omit_script=1&dnt=true`;
      const r = await http(oembedUrl, { accept: "application/json", maxBytes: 512 * 1024, timeoutMs: 20_000 });
      if (r.status !== 200) { report.status = "failed"; report.retrieval = `X oEmbed answered HTTP ${r.status}; the post may be deleted, private or age-restricted`; return await done(); }
      doc = parseOembed(JSON.parse(r.body), x.url); report.retrieved = true; report.retrieval = "one post through X's oEmbed endpoint";
      if (input.kind === "x_thread") report.limitations.push("oEmbed returns only the first post of a thread; paste the rest of the thread's text to import it");
    } else if (canonical) {
      // A platform programme URL: identity is known from the URL itself.
      const sourceForIt = SOURCE_FOR_PLATFORM[canonical.platform];
      const existing = await pool.query<{ id: string }>("SELECT id FROM bounty_programs WHERE canonical_key = $1", [canonical.key]);
      if (!existing.rows[0] && sourceForIt && ADAPTERS[sourceForIt] && !ADAPTERS[sourceForIt]!.blocked && sourcesEnabled.get(sourceForIt)?.enabled) {
        const run = await runCollection(pool, { trigger: "import", startedBy: input.submittedBy, sources: [sourceForIt], force: true, http, now });
        report.retrieval = `refreshed the ${sourceForIt} listing (${run.checks[0]?.outcome ?? run.status})`; report.retrieved = run.checks[0]?.outcome === "fetched";
      } else if (!existing.rows[0]) {
        report.retrieval = "not retrieved";
        report.limitations.push(sourceForIt && ADAPTERS[sourceForIt]?.blocked ? `${canonical.platform} pages are not fetched: ${ADAPTERS[sourceForIt]!.blocked}` : `${canonical.platform} is not an enabled collection source; the record is created from the URL alone`);
      } else report.retrieval = "already known; not fetched again";
      const o = emptyOpportunity(`${url}`, canonical.programmeId.replace(/-/g, " "));
      o.officialUrl = url; o.platform = canonical.platform; o.unresolved.push("maxReward");
      doc = null;
      await save([o], "platform programme URL", report, pool, { sourceKey: "web-import", importId, url, now });
      return await done();
    } else if (host === "bug-bounty-board.vercel.app") {
      const run = await runCollection(pool, { trigger: "import", startedBy: input.submittedBy, sources: ["community-board"], force: true, http, now });
      const c = run.checks[0];
      report.retrieved = c?.outcome === "fetched"; report.retrieval = `refreshed the community board (${c?.outcome ?? run.status})`;
      if (c) { report.discovered = c.listings; report.added = c.added; report.updated = c.updated; report.matched = c.matched + c.unchanged; report.needsVerification = c.needsVerification; }
      if (!report.retrieved) { report.status = "failed"; if (c?.error) report.limitations.push(c.error); }
      report.limitations.push("the board is one list: importing any board URL refreshes the whole board");
      return await done();
    } else {
      const robots = await checkRobots(http, url!);
      if (!robots.allowed) { report.status = "blocked"; report.retrieval = `not retrieved: robots.txt (${robots.reason})`; report.limitations.push("paste the page text together with the URL to import it without fetching"); return await done(); }
      const r = await http(url!, { maxBytes: 2 * 1024 * 1024, timeoutMs: 30_000 });
      if (r.status !== 200) { report.status = "failed"; report.retrieval = `HTTP ${r.status}`; return await done(); }
      if (!/text\/html|text\/plain|application\/json|application\/xhtml/i.test(r.contentType)) { report.status = "failed"; report.retrieval = `unsupported content type ${r.contentType || "(none)"}`; return await done(); }
      const d = /html/i.test(r.contentType) ? htmlToDocument(r.body, r.finalUrl) : { text: r.body, links: [], title: null };
      doc = { text: d.text, links: d.links, baseUrl: r.finalUrl, author: null, publishedAt: null, title: d.title };
      report.retrieved = true; report.retrieval = `fetched ${r.bytes} bytes`;
      if (d.text.length < 200 && /<script/i.test(r.body)) report.limitations.push("the page is built by JavaScript in the browser; its content may be missing. Paste the visible text instead.");
    }

    const ex = extractOpportunities(doc!, refBase);
    report.ignoredSegments = ex.ignoredSegments; report.unresolvedLinks = ex.unresolvedLinks;
    if (ex.unresolvedLinks.length) report.limitations.push(`${ex.unresolvedLinks.length} shortened link(s) could not be expanded; include the full URLs in pasted text`);
    // Platform links in the content: refresh each enabled platform listing once, so the opportunity gets the platform's own data.
    const platforms = new Set(ex.items.map((o) => canonicalFromUrl(o.officialUrl)?.platform).filter((p): p is string => !!p));
    for (const p of platforms) {
      const src = SOURCE_FOR_PLATFORM[p];
      if (!src || ADAPTERS[src]?.blocked || !sourcesEnabled.get(src)?.enabled) continue;
      const keys = ex.items.map((o) => canonicalFromUrl(o.officialUrl)?.key).filter((k): k is string => !!k && k.startsWith(`${p}:`));
      const known = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM bounty_programs WHERE canonical_key = ANY($1)", [keys]);
      if (known.rows[0]!.n < keys.length) { await runCollection(pool, { trigger: "import", startedBy: input.submittedBy, sources: [src], force: true, http, now }); report.limitations.push(`refreshed the ${src} listing for linked programmes`); }
    }
    if (!ex.items.length) { report.limitations.push("no bounty opportunity was found in this content"); return await done(); }
    await save(ex.items, sourceKey === "x" ? "X post text" : sourceKey === "text-import" ? "pasted text" : "web page", report, pool, { sourceKey, importId, url, now });
    return await done();
  } catch (e) {
    report.status = "failed"; report.retrieval = report.retrieval || (e instanceof BountyError ? `${e.code}: ${e.message}` : (e as Error).message);
    if (e instanceof BountyError) report.limitations.push(`${e.code}: ${e.message}`);
    return await done();
  }
}

async function save(items: ExtractedOpportunity[], method: string, report: ImportReport, pool: Pool, c: { sourceKey: string; importId: string; url: string | null; now: () => Date }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const t = c.now();
    for (const item of items) {
      const u = await upsertObservation(client, { sourceKey: c.sourceKey, item, extractionMethod: method, sourceUrl: c.url, importId: c.importId, now: t });
      const r = await recomputeProgram(client, u.programId, t, { sourceKey: c.sourceKey });
      report.discovered += 1;
      if (u.outcome === "added") report.added += 1; else if (u.outcome === "updated") report.updated += 1; else report.matched += 1;
      if (r.needsVerification) report.needsVerification += 1;
      report.items.push({ programId: u.programId, project: r.projectName, outcome: u.outcome, matchBasis: u.matchBasis, verification: r.verification, status: r.status,
        maxReward: r.resolved.maxReward?.value ?? null, officialUrl: r.resolved.officialUrl?.value ?? null });
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
