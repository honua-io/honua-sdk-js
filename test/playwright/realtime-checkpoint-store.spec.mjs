import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The page runs a realtime subscription against the IndexedDB checkpoint store.
// `mode` is carried in sessionStorage so a real reload — not a new context —
// exercises the durable resume path.
const PAGE = `<!doctype html><title>Realtime checkpoint store</title><script type="module">
  import {
    createIndexedDbRealtimeCheckpointStore,
    createResumableRealtimeSubscription,
  } from "/dist/src/realtime/index.js";

  const context = {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId: "incidents",
    queryFingerprint: "sha256:" + "a".repeat(64),
    sourceVersion: "incidents-snapshot-v7",
    schemaVersion: "incident-schema-v3",
    authorizationScopeFingerprint: "dispatch-read-v2",
  };

  const run = async () => {
    const database = new URL(location.href).searchParams.get("database") ?? "honua-realtime-checkpoint-test";
    const mode = sessionStorage.getItem("realtime-checkpoint-mode") ?? "write";
    const scenario = new URL(location.href).searchParams.get("scenario") ?? "resume";
    const diagnostics = [];
    const store = createIndexedDbRealtimeCheckpointStore({
      name: database,
      onDiagnostic: (diagnostic) => diagnostics.push({ operation: diagnostic.operation, reason: diagnostic.reason }),
    });

    if (mode === "write") {
      const applied = [];
      const first = await createResumableRealtimeSubscription({
        context,
        checkpointStore: store,
        apply: (event) => applied.push(event.type),
      });
      await first.enqueue({
        type: "snapshot",
        eventId: "snapshot-5",
        sequence: 5,
        cursor: "cursor-5",
        watermark: "watermark-5",
        features: [{ sourceId: "incidents", id: 1, feature: { id: 1, status: "open" } }],
      });
      await first.enqueue({
        type: "upsert",
        eventId: "delta-6",
        sequence: 6,
        cursor: "cursor-6",
        feature: { sourceId: "incidents", id: 1, feature: { id: 1, status: "assigned" } },
      });
      const written = {
        phase: first.state.phase,
        persisted: first.state.checkpointPersisted,
        applied,
        diagnostics,
        records: (await store.records()).length,
      };
      first.close();
      if (scenario === "scope-change") {
        sessionStorage.setItem("realtime-checkpoint-scope", "incidents-snapshot-v8");
      }
      sessionStorage.setItem("realtime-checkpoint-mode", "read");
      window.__realtimeCheckpoint = written;
      return;
    }

    const sourceVersion = sessionStorage.getItem("realtime-checkpoint-scope") ?? context.sourceVersion;
    const reloadContext = { ...context, sourceVersion };
    const applied = [];
    const resumed = await createResumableRealtimeSubscription({
      context: reloadContext,
      checkpointStore: store,
      apply: (event) => applied.push(event.type),
    });
    const delta = await resumed.enqueue({
      type: "upsert",
      eventId: "delta-7",
      sequence: 7,
      cursor: "cursor-7",
      feature: { sourceId: "incidents", id: 1, feature: { id: 1, status: "closed" } },
    });
    const records = await store.records();
    window.__realtimeCheckpoint = {
      phase: resumed.state.phase,
      persisted: resumed.state.checkpointPersisted,
      resumedSequence: resumed.state.checkpoint?.resume?.sequence ?? null,
      resumedCursor: resumed.state.checkpoint?.resume?.cursor ?? null,
      deltaStatus: delta.status,
      deltaReason: delta.reason ?? null,
      applied,
      diagnostics,
      recordKeys: [...new Set(records.flatMap((record) => Object.keys(record)))].sort(),
      recordStrings: records.flatMap((record) => [
        record.key,
        record.format,
        record.sourceId,
        record.queryFingerprint,
        record.sourceVersion,
        record.schemaVersion,
        record.authorizationScopeDigest,
        ...Object.values(record.resume).filter((value) => typeof value === "string"),
      ]),
    };
  };

  run().catch((error) => {
    window.__realtimeCheckpoint = { error: String(error) };
  });
</script>`;

test("realtime subscription resumes from a stored cursor across a real reload", async ({ page }) => {
  const server = await startServer();
  const database = `honua-realtime-checkpoint-${Date.now()}`;
  try {
    await page.goto(`${server.url}/?database=${database}`);
    await expect.poll(() => page.evaluate(() => window.__realtimeCheckpoint)).toMatchObject({
      phase: "live",
      persisted: true,
      records: 1,
      diagnostics: [],
    });

    await page.reload({ waitUntil: "load" });
    const resumed = await pollState(page);
    expect(resumed).toMatchObject({
      phase: "live",
      resumedSequence: 7,
      resumedCursor: "cursor-7",
      deltaStatus: "applied",
      diagnostics: [],
    });
    // The reload resumed from the stored cursor: no replacement snapshot was
    // needed for the next contiguous delta to apply.
    expect(resumed.applied).toEqual(["upsert"]);
    expect(resumed.recordKeys).toEqual([
      "authorizationScopeDigest",
      "format",
      "key",
      "observedAt",
      "queryFingerprint",
      "resume",
      "savedAt",
      "schemaVersion",
      "sourceId",
      "sourceVersion",
    ]);
    for (const value of resumed.recordStrings) {
      expect(value).not.toMatch(/^https?:\/\//i);
      expect(value).not.toMatch(/[?#@]/);
      expect(value).not.toMatch(/(?:authorization|bearer|cookie|password|secret|session|token|api[-_]?key)/i);
    }
    // Only the digest of the authorization scope is persisted.
    expect(resumed.recordStrings).not.toContain("dispatch-read-v2");
  } finally {
    await server.close();
  }
});

test("realtime reload discards a stored cursor whose scope identity changed", async ({ page }) => {
  const server = await startServer();
  const database = `honua-realtime-checkpoint-scope-${Date.now()}`;
  try {
    await page.goto(`${server.url}/?database=${database}&scenario=scope-change`);
    await expect.poll(() => page.evaluate(() => window.__realtimeCheckpoint)).toMatchObject({
      phase: "live",
      persisted: true,
      records: 1,
    });

    await page.reload({ waitUntil: "load" });
    const resumed = await pollState(page);
    expect(resumed).toMatchObject({
      phase: "resnapshot-required",
      deltaStatus: "resnapshot-required",
      deltaReason: "snapshot-required",
      resumedSequence: null,
    });
    // The stale record is deleted, not silently left behind.
    expect(resumed.recordKeys).toEqual([]);
    expect(resumed.diagnostics).toEqual([{ operation: "load", reason: "source-version-changed" }]);
  } finally {
    await server.close();
  }
});

async function pollState(page) {
  await expect.poll(() => page.evaluate(() => window.__realtimeCheckpoint?.phase)).toEqual(expect.any(String));
  return page.evaluate(() => window.__realtimeCheckpoint);
}

async function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(PAGE);
      return;
    }
    if (url.pathname.startsWith("/dist/")) {
      try {
        const file = await readFile(path.join(repoRoot, url.pathname));
        response.setHeader("content-type", "application/javascript; charset=utf-8");
        response.end(file);
      } catch {
        response.statusCode = 404;
        response.end("not found");
      }
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
