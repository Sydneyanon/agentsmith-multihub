import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../step-errors.js";
import { MAX_BLOB_BYTES, extractSpan, manifestSha256, sha256Hex, splitLines } from "../research-state.js";
import { assertIntegrationConfigured, expireLease, migratedTestDatabase, skipIntegration, type TestDatabase } from "./harness.js";
import { ResearchFixture, VAULT } from "./research-helpers.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(skipIntegration)("research state: blobs, snapshots and evidence spans (real Postgres)", () => {
  let db: TestDatabase;
  let fx: ResearchFixture;
  beforeAll(async () => {
    assertIntegrationConfigured();
    db = await migratedTestDatabase();
    fx = new ResearchFixture(db);
  });
  afterAll(async () => { await db?.drop(); });

  describe("content-addressed blobs", () => {
    it("stores bytes under their SHA-256 and verifies hash and size in the database", async () => {
      const content = Buffer.from("hello research", "utf8");
      const sha = await fx.rawBlob(content);
      const row = (await fx.pool.query("SELECT size_bytes, content FROM research_blobs WHERE content_sha256 = $1", [sha])).rows[0]!;
      expect(row.size_bytes).toBe(content.length);
      await expect(fx.pool.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3)", ["0".repeat(64), 3, Buffer.from("abc")])).rejects.toThrow(/check constraint/);
      await expect(fx.pool.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3)", [sha256Hex("abc"), 99, Buffer.from("abc")])).rejects.toThrow(/check constraint/);
    });

    it("rejects a blob over 1 MiB in the database as well as in the application", async () => {
      const big = Buffer.alloc(MAX_BLOB_BYTES + 1, 7);
      await expect(fx.pool.query("INSERT INTO research_blobs (content_sha256, size_bytes, content) VALUES ($1,$2,$3)", [sha256Hex(big), big.length, big])).rejects.toThrow(/check constraint/);
      const exactly = Buffer.alloc(MAX_BLOB_BYTES, 9);
      expect(await fx.rawBlob(exactly)).toBe(sha256Hex(exactly));
    });

    it("is idempotent through the store and immutable at the database level", async () => {
      const ctx = await fx.step();
      const a = await fx.store.putBlob(ctx.lease, Buffer.from("same bytes"));
      const b = await fx.store.putBlob(ctx.lease, Buffer.from("same bytes"));
      expect(b).toEqual(a);
      expect((await fx.pool.query("SELECT count(*)::int AS n FROM research_blobs WHERE content_sha256 = $1", [a.sha256])).rows[0]!.n).toBe(1);
      await expect(fx.pool.query("UPDATE research_blobs SET size_bytes = size_bytes WHERE content_sha256 = $1", [a.sha256])).rejects.toThrow(/immutable/);
      await expect(fx.pool.query("DELETE FROM research_blobs WHERE content_sha256 = $1", [a.sha256])).rejects.toThrow(/immutable/);
    });

    it("evicts an uncited blob through the audited function and records it", async () => {
      const sha = await fx.rawBlob(Buffer.from(`evict me ${fx.next()}`));
      expect(await fx.pool.query("SELECT evict_research_blob($1, 'retention test', 'tester') AS ok", [sha]).then((r) => r.rows[0]!.ok)).toBe(true);
      expect((await fx.pool.query("SELECT 1 FROM research_blobs WHERE content_sha256 = $1", [sha])).rowCount).toBe(0);
      const audit = (await fx.pool.query("SELECT * FROM research_blob_evictions WHERE content_sha256 = $1", [sha])).rows[0]!;
      expect(audit).toMatchObject({ reason: "retention test", evicted_by: "tester" });
      expect(await fx.pool.query("SELECT evict_research_blob($1, 'again', 'tester') AS ok", [sha]).then((r) => r.rows[0]!.ok)).toBe(false);
      await expect(fx.pool.query("UPDATE research_blob_evictions SET reason = 'edited' WHERE id = $1", [audit.id])).rejects.toThrow(/append-only/);
    });

    it("refuses to evict a blob that is cited as evidence", async () => {
      const ctx = await fx.sealedSnapshot();
      await fx.span(ctx, 4, 6);
      const blobSha = sha256Hex(VAULT);
      await expect(fx.pool.query("SELECT evict_research_blob($1, 'should fail', 'tester')", [blobSha])).rejects.toThrow(/cited as evidence/);
      expect((await fx.pool.query("SELECT 1 FROM research_blobs WHERE content_sha256 = $1", [blobSha])).rowCount).toBe(1);
    });

    it("reports storage statistics", async () => {
      const stats = (await fx.pool.query("SELECT * FROM research_storage_stats")).rows[0]!;
      expect(Number(stats.blobs)).toBeGreaterThan(0);
      expect(Number(stats.blob_bytes)).toBeGreaterThan(0);
      expect(Number(stats.evictions)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("snapshots and the manifest", () => {
    it("accounts for every file: stored with a blob, or skipped with a reason", async () => {
      const snap = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("contract A {}"));
      await fx.rawFile(snap, "src/A.sol", blob, 13);
      await fx.rawInsertFile(snap, { path: "big.bin", size: 9_999_999, classification: "other", skipReason: "oversize" });
      await expect(fx.rawInsertFile(snap, { path: "silent.bin", size: 5, classification: "other" })).rejects.toThrow(/check constraint/);
      await expect(fx.rawInsertFile(snap, { path: "both.sol", blobSha: blob, size: 13, skipReason: "binary" })).rejects.toThrow(/check constraint/);
      await expect(fx.rawInsertFile(snap, { path: "why.bin", size: 5, classification: "other", skipReason: "because" })).rejects.toThrow(/check constraint/);
    });

    it("rejects unsafe paths", async () => {
      const snap = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("x"));
      for (const path of ["/etc/passwd", "../escape.sol", "a/../b.sol", "a//b.sol", "./a.sol", "a/./b.sol", "tab\tname.sol", "line\nbreak.sol", ""]) {
        await expect(fx.rawFile(snap, path, blob, 1), JSON.stringify(path)).rejects.toThrow(/check constraint/);
      }
      await fx.rawFile(snap, "ok/dir/file.sol", blob, 1);
    });

    it("requires the blob to exist and its size to match", async () => {
      const snap = await fx.rawSnapshot();
      await expect(fx.rawFile(snap, "a.sol", "e".repeat(64), 1)).rejects.toThrow(/is not stored/);
      const blob = await fx.rawBlob(Buffer.from("four"));
      await expect(fx.rawFile(snap, "b.sol", blob, 5)).rejects.toThrow(/does not match stored blob size/);
      await expect(fx.rawFile(snap, "c.sol", blob, 4)).resolves.toBeUndefined();
    });

    it("rejects a duplicate path and any edit of a manifest row", async () => {
      const snap = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("dup"));
      await fx.rawFile(snap, "a.sol", blob, 3);
      await expect(fx.rawFile(snap, "a.sol", blob, 3)).rejects.toThrow(/duplicate key/);
      await expect(fx.pool.query("UPDATE repo_snapshot_files SET classification = 'test' WHERE snapshot_id = $1", [snap])).rejects.toThrow(/append-only/);
      await expect(fx.pool.query("DELETE FROM repo_snapshot_files WHERE snapshot_id = $1", [snap])).rejects.toThrow(/append-only/);
    });

    it("seals with database-computed counts and a manifest hash the application reproduces, in byte order", async () => {
      const ctx = await fx.step();
      const id = await fx.store.createSnapshot(ctx.lease, { repository: "acme/order", commitSha: fx.commit() });
      const files = { "z.sol": "zz", "B.sol": "bb", "a.sol": "aa", "é.sol": "ee", "dir/x.sol": "xx" };
      const entries = [];
      for (const [path, text] of Object.entries(files)) {
        const blob = await fx.store.putBlob(ctx.lease, Buffer.from(text));
        entries.push({ path, classification: "source", sizeBytes: blob.sizeBytes, blobSha256: blob.sha256 });
      }
      entries.push({ path: "skipped.bin", classification: "other", sizeBytes: 5_000_000, skipReason: "oversize" } as never);
      await fx.store.addSnapshotFiles(ctx.lease, id, entries);
      const sealed = await fx.store.sealSnapshot(ctx.lease, id);
      expect(sealed.fileCount).toBe(6);
      expect(sealed.totalBytes).toBe(10); // stored bytes only; the skipped file is not counted
      const expected = manifestSha256(entries.map((e: any) => ({ path: e.path, blobSha256: e.blobSha256 ?? null, skipReason: e.skipReason ?? null })));
      expect(sealed.manifestSha256).toBe(expected);
      expect(await fx.store.verifySnapshot(id)).toMatchObject({ ok: true, sealed: true, manifest_matches: true, evicted_blobs: 0, hash_mismatches: 0 });
    });

    it("is immutable once sealed: no new files, no edits, no second seal, no hand-written manifest", async () => {
      const ctx = await fx.sealedSnapshot();
      const blob = await fx.rawBlob(Buffer.from("late"));
      await expect(fx.rawFile(ctx.snapshotId, "late.sol", blob, 4)).rejects.toThrow(/is sealed/);
      await expect(fx.pool.query("UPDATE repo_snapshots SET repository = 'evil/repo' WHERE id = $1", [ctx.snapshotId])).rejects.toThrow(/sealed and immutable/);
      await expect(fx.pool.query("UPDATE repo_snapshots SET sealed_at = now() WHERE id = $1", [ctx.snapshotId])).rejects.toThrow(/sealed and immutable/);
      await expect(fx.pool.query("DELETE FROM repo_snapshots WHERE id = $1", [ctx.snapshotId])).rejects.toThrow(/append-only/);
      await expect(fx.store.sealSnapshot(ctx.lease, ctx.snapshotId)).rejects.toThrow(/sealed and immutable/);
    });

    it("ignores a hand-written manifest at seal time: the database computes it", async () => {
      const snap = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("real"));
      await fx.rawFile(snap, "a.sol", blob, 4);
      await fx.rawSeal(snap, "manifest_sha256 = $3, file_count = 99, total_bytes = 12345", ["f".repeat(64)]);
      const row = (await fx.pool.query("SELECT manifest_sha256, file_count, total_bytes FROM repo_snapshots WHERE id = $1", [snap])).rows[0]!;
      expect(row.file_count).toBe(1);
      expect(Number(row.total_bytes)).toBe(4);
      expect(row.manifest_sha256).toBe(manifestSha256([{ path: "a.sol", blobSha256: blob, skipReason: null }]));
    });

    it("enforces the file-count and byte limits at seal time", async () => {
      const many = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("tiny"));
      const owner = fx.owner(many);
      await fx.pool.query(
        `INSERT INTO repo_snapshot_files (snapshot_id, workflow_run_id, produced_by_step_id, path, blob_sha256, size_bytes, classification)
         SELECT $1, $3, $4, 'f' || g || '.sol', $2, 4, 'source' FROM generate_series(1, 20001) g`, [many, blob, owner.runId, owner.stepId]);
      await expect(fx.rawSeal(many)).rejects.toThrow(/the limit is 20000/);

      const heavy = await fx.rawSnapshot();
      for (let i = 0; i < 65; i += 1) {
        const content = Buffer.alloc(MAX_BLOB_BYTES, i + 1);
        await fx.rawFile(heavy, `blob${i}.bin`, await fx.rawBlob(content), content.length);
      }
      await expect(fx.rawSeal(heavy)).rejects.toThrow(/the limit is 67108864/);
    });

    it("detects a tampered manifest", async () => {
      const ctx = await fx.sealedSnapshot({ "a.sol": "contract A {}", "b.sol": `contract B {} // ${fx.next()}` });
      await fx.withTriggerDisabled("repo_snapshots", "repo_snapshots_guard", () =>
        fx.pool.query("UPDATE repo_snapshots SET manifest_sha256 = $2 WHERE id = $1", [ctx.snapshotId, "0".repeat(64)]));
      expect(await fx.store.verifySnapshot(ctx.snapshotId)).toMatchObject({ ok: false, manifest_matches: false });
    });

    it("reports an evicted blob as such", async () => {
      const text = `contract Evictable {} // ${fx.next()}`;
      const ctx = await fx.sealedSnapshot({ "e.sol": text });
      expect(await fx.pool.query("SELECT evict_research_blob($1, 'verify test', 'tester') AS ok", [sha256Hex(text)]).then((r) => r.rows[0]!.ok)).toBe(true);
      expect(await fx.store.verifySnapshot(ctx.snapshotId)).toMatchObject({ ok: false, evicted_blobs: 1, hash_mismatches: 0, manifest_matches: true });
    });
  });

  describe("evidence spans", () => {
    it("cites exact lines, resolves them from the stored bytes and verifies in the database", async () => {
      const ctx = await fx.sealedSnapshot();
      const id = await fx.span(ctx, 4, 6);
      const resolved = await fx.store.resolveSpan(id);
      expect(resolved).toMatchObject({ ok: true, path: "contracts/Vault.sol", lineStart: 4, lineEnd: 6 });
      expect((resolved as { text: string }).text).toBe(extractSpan(VAULT, 4, 6));
      expect((resolved as { text: string }).text.split("\n")[1]).toContain("msg.sender.call");
      expect(await fx.store.verifySpan(id)).toBe("ok");
      expect(await fx.span(ctx, 4, 6)).toBe(id); // the same range is the same span
    });

    it("refuses a wrong excerpt hash, a missing range and a span on an unsealed snapshot", async () => {
      const ctx = await fx.sealedSnapshot();
      const blob = sha256Hex(VAULT);
      fx.adopt(ctx);
      const insert = (start: number, end: number, hash: string, snapshot = ctx.snapshotId) =>
        fx.rawSpan(snapshot, "contracts/Vault.sol", blob, start, end, hash);
      await expect(insert(4, 6, "1".repeat(64))).rejects.toThrow(/does not resolve \(mismatch\)/);
      await expect(insert(4, 99, sha256Hex("x"))).rejects.toThrow(/does not resolve \(range_error\)/);
      await expect(insert(9, 9, sha256Hex(""))).rejects.toThrow(/does not resolve \(range_error\)/); // the trailing newline is not a ninth line
      const building = await fx.rawSnapshot();
      const b = await fx.rawBlob(Buffer.from(VAULT));
      await fx.rawFile(building, "contracts/Vault.sol", b, VAULT.length);
      await expect(insert(1, 1, sha256Hex(splitLines(VAULT)[0]!), building)).rejects.toThrow(/sealed snapshot/);
    });

    it("cannot cite a file that was skipped, is not in the snapshot, or has a different blob", async () => {
      const snap = await fx.rawSnapshot();
      const blob = await fx.rawBlob(Buffer.from("line1\nline2\n"));
      await fx.rawFile(snap, "real.sol", blob, 12);
      await fx.rawInsertFile(snap, { path: "skipped.sol", size: 50, skipReason: "oversize" });
      await fx.rawSeal(snap);
      const insert = (path: string, blobSha: string) => fx.rawSpan(snap, path, blobSha, 1, 1, sha256Hex("line1"));
      await expect(insert("skipped.sol", blob)).rejects.toThrow(/foreign key/);
      await expect(insert("missing.sol", blob)).rejects.toThrow(/foreign key/);
      await expect(insert("real.sol", sha256Hex("other"))).rejects.toThrow(/does not resolve|foreign key/);
    });

    it("limits a span to 400 lines and refuses non-text bytes", async () => {
      const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
      const ctx = await fx.sealedSnapshot({ "long.txt": long, "bin.dat": "placeholder" });
      await expect(fx.store.createEvidenceSpan(ctx.lease, { snapshotId: ctx.snapshotId, path: "long.txt", lineStart: 1, lineEnd: 401 })).rejects.toThrow(/check constraint/);
      expect(await fx.store.createEvidenceSpan(ctx.lease, { snapshotId: ctx.snapshotId, path: "long.txt", lineStart: 1, lineEnd: 400 })).toBeTruthy();

      const snap = await fx.rawSnapshot();
      const bad = await fx.rawBlob(Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
      await fx.rawFile(snap, "bad.bin", bad, 4);
      await fx.rawSeal(snap);
      await expect(fx.rawSpan(snap, "bad.bin", bad, 1, 1, sha256Hex("f"))).rejects.toThrow(/not_text/);
    });

    it("agrees with the application on line semantics for awkward texts", async () => {
      const texts = ["a\nb\nc", "a\nb\n", "\n", "", "x\r\ny\r\n", "é\n日本\n", "a\n\n\nb", "single"];
      for (const text of texts) {
        const blob = await fx.rawBlob(Buffer.from(text, "utf8"));
        const lines = splitLines(text);
        for (let start = 1; start <= lines.length; start += 1) {
          for (let end = start; end <= lines.length; end += 1) {
            const hash = sha256Hex(Buffer.from(extractSpan(text, start, end)!, "utf8"));
            const verdict = (await fx.pool.query("SELECT research_span_check($1,$2,$3,$4) AS v", [blob, start, end, hash])).rows[0]!.v;
            expect(verdict, `${JSON.stringify(text)} ${start}-${end}`).toBe("ok");
          }
        }
        const beyond = (await fx.pool.query("SELECT research_span_check($1,1,$2,$3) AS v", [blob, lines.length + 1, sha256Hex("x")])).rows[0]!.v;
        expect(beyond, JSON.stringify(text)).toBe("range_error");
        expect(extractSpan(text, 1, lines.length + 1)).toBeNull();
      }
    });

    it("fails closed when evidence is tampered with or its blob is removed outside the audited function", async () => {
      const ctx = await fx.sealedSnapshot({ "t.sol": `line one\nline two // ${fx.next()}\n` });
      const id = await fx.span(ctx, 1, 2, "t.sol");
      expect(await fx.store.verifySpan(id)).toBe("ok");
      await fx.withTriggerDisabled("evidence_spans", "evidence_spans_immutable", () =>
        fx.pool.query("UPDATE evidence_spans SET excerpt_sha256 = $2 WHERE id = $1", [id, "2".repeat(64)]));
      expect(await fx.store.verifySpan(id)).toBe("mismatch");
      expect(await fx.store.resolveSpan(id)).toMatchObject({ ok: false, reason: "mismatch" });
    });

    it("documented limitation: an owner-level SQL user can still remove a cited blob, and verification then reports it as evicted", async () => {
      const ctx = await fx.sealedSnapshot({ "o.sol": `owner level // ${fx.next()}\n` });
      const id = await fx.span(ctx, 1, 1, "o.sol");
      const client = await fx.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('agentsmith.blob_eviction', 'on', true)");
        await client.query("DELETE FROM research_blobs WHERE content_sha256 = (SELECT blob_sha256 FROM evidence_spans WHERE id = $1)", [id]);
        await client.query("COMMIT");
      } finally { client.release(); }
      expect(await fx.store.verifySpan(id)).toBe("evicted");
      expect(await fx.store.resolveSpan(id)).toMatchObject({ ok: false, reason: "evicted" });
    });
  });

  describe("writes are tied to the workflow queue", () => {
    it("records the run and producing step from the lease", async () => {
      const ctx = await fx.sealedSnapshot();
      const row = (await fx.pool.query("SELECT workflow_run_id, produced_by_step_id FROM repo_snapshots WHERE id = $1", [ctx.snapshotId])).rows[0]!;
      expect(row).toMatchObject({ workflow_run_id: ctx.runId, produced_by_step_id: ctx.lease.stepId });
    });

    it("refuses every kind of write once the lease has expired, and leaves nothing behind", async () => {
      const ctx = await fx.sealedSnapshot();
      await expireLease(fx.pool, ctx.lease.stepId);
      const before = Number((await fx.pool.query("SELECT count(*) FROM research_blobs")).rows[0]!.count);
      await expect(fx.store.putBlob(ctx.lease, Buffer.from(`late ${fx.next()}`))).rejects.toBeInstanceOf(LeaseLostError);
      await expect(fx.store.createSnapshot(ctx.lease, { repository: "acme/late", commitSha: fx.commit() })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(fx.span(ctx, 1, 1)).rejects.toBeInstanceOf(LeaseLostError);
      expect(Number((await fx.pool.query("SELECT count(*) FROM research_blobs")).rows[0]!.count)).toBe(before);
    });

    it("refuses a worker that does not own the step", async () => {
      const ctx = await fx.step();
      await expect(fx.store.putBlob({ stepId: ctx.lease.stepId, workerId: "someone-else" }, Buffer.from("x"))).rejects.toBeInstanceOf(LeaseLostError);
    });

    it("rejects a snapshot for a run that does not exist", async () => {
      const real = await fx.step();
      await expect(fx.pool.query(
        "INSERT INTO repo_snapshots (workflow_run_id, produced_by_step_id, source_host, repository, commit_sha) VALUES ($1,$2,'github.com','a/b',$3)",
        ["00000000-0000-4000-8000-000000000999", real.lease.stepId, fx.commit()])).rejects.toThrow(/foreign key/);
    });
  });
});
