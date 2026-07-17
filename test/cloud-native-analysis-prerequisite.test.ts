import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_NATIVE_ANALYSIS_FIXTURE_PATH,
  CLOUD_NATIVE_ANALYSIS_FIXTURE_SHA256,
  prepareCloudNativeAnalysisPrerequisite,
} from "../examples/spatial-analytics-workbench/src/cloud-native-prerequisite.js";

const fixtureFile = new URL(
  "../examples/spatial-analytics-workbench/public/fixtures/cloud-native-analysis-columnar.v1.json",
  import.meta.url,
);
const moduleFile = new URL("../examples/spatial-analytics-workbench/src/cloud-native-prerequisite.ts", import.meta.url);
const defaultQuery = {
  aoi: [-157.872, 21.286, -157.812, 21.331] as const,
  limit: 16,
};

async function fixtureResponse(headers: Record<string, string> = {}): Promise<Response> {
  const bytes = await readFile(fixtureFile);
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength), "content-type": "application/json", ...headers },
  });
}

async function fixtureFetch() {
  const fetcher = vi.fn<typeof fetch>(async () => fixtureResponse());
  return fetcher;
}

describe("Cloud-Native Spatial Analysis S1 prerequisite", () => {
  it("prepares one deterministic public-SDK columnar artifact with bounded, qualified truth", async () => {
    const fetcher = await fixtureFetch();
    const first = await prepareCloudNativeAnalysisPrerequisite({
      origin: "https://sample.test/workbench",
      query: defaultQuery,
      acceptsColumnar: true,
      fetch: fetcher,
    });
    const second = await prepareCloudNativeAnalysisPrerequisite({
      origin: "https://sample.test/another-route",
      query: defaultQuery,
      acceptsColumnar: true,
      fetch: await fixtureFetch(),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://sample.test${CLOUD_NATIVE_ANALYSIS_FIXTURE_PATH}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    expect(first.artifact.kind).toBe("columnar-batch");
    if (first.artifact.kind !== "columnar-batch") throw new Error("Expected a columnar artifact");
    expect(first.artifact.batch).toMatchObject({
      kind: "honua.columnar-batch",
      version: "1.0",
      rowCount: 4,
      sequence: 0,
    });
    expect(first.artifact.metrics).toMatchObject({
      rows: 4,
      backingBytes: 144,
      logicalBytes: 144,
      copiedBytes: 0,
      bufferViews: 6,
    });
    expect(first.truth).toMatchObject({
      schemaVersion: "honua.sample.cloud-native-analysis-prerequisite-truth.v1",
      workflow: "bounded-columnar-analysis-prerequisite",
      qualification: "fixture-prerequisite-only",
      source: {
        mode: "fixture",
        sameOrigin: true,
        byteLength: 1340,
        objectVersion: `sha256:${CLOUD_NATIVE_ANALYSIS_FIXTURE_SHA256}`,
      },
      query: {
        selectedRowGroupIds: ["honolulu-urban-core"],
        availableRowGroups: 3,
      },
      artifact: {
        kind: "columnar-batch",
        rows: 4,
        backingBytes: 144,
        artifactFidelity: "fixture-exact",
      },
      fallback: { selected: "none", maxRows: 4 },
      claims: {
        sameOriginFetch: { state: "observed" },
        partitionSelection: { state: "fixture-evaluated" },
        rowGroupPruning: { state: "fixture-modeled" },
        rangeAccess: { state: "unobserved" },
        workerExecution: { state: "unobserved" },
        peakMemory: { state: "unobserved" },
      },
    });
    expect(first.truth.degradations.map((entry) => entry.code)).toEqual([
      "range-access-unobserved",
      "worker-execution-unobserved",
      "peak-memory-unobserved",
    ]);
    expect(first.truth.cacheIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.truth.cacheIdentity).toBe(first.truth.cacheIdentity);
  });

  it("uses a clearly degraded object fallback only inside its explicit row ceiling", async () => {
    const prepared = await prepareCloudNativeAnalysisPrerequisite({
      origin: "http://127.0.0.1:4173",
      query: defaultQuery,
      acceptsColumnar: false,
      fetch: await fixtureFetch(),
    });

    expect(prepared.artifact.kind).toBe("bounded-object-fallback");
    if (prepared.artifact.kind !== "bounded-object-fallback") throw new Error("Expected object fallback");
    expect(prepared.artifact.rows.map((row) => row.id)).toEqual([
      "asset-001",
      "parcel-002",
      "facility-003",
      "incident-004",
    ]);
    expect(prepared.truth.fallback).toMatchObject({ selected: "bounded-object", maxRows: 4 });
    expect(prepared.truth.artifact).toMatchObject({ rows: 4, backingBytes: null });
    expect(prepared.truth.degradations[0]).toMatchObject({ code: "columnar-consumer-unavailable" });

    await expect(
      prepareCloudNativeAnalysisPrerequisite({
        origin: "http://127.0.0.1:4173",
        query: { aoi: [-180, -90, 180, 90], limit: 16 },
        acceptsColumnar: false,
        fetch: await fixtureFetch(),
      }),
    ).rejects.toMatchObject({
      code: "unsafe-materialization",
      message: expect.stringContaining("8 rows exceed"),
    });
  });

  it("fails before fetching cross-origin data and before reading declared oversized bodies", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      prepareCloudNativeAnalysisPrerequisite({
        origin: "https://sample.test",
        fixturePath: "https://cdn.example.test/cloud-native.json",
        query: defaultQuery,
        acceptsColumnar: true,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "cross-origin-fixture" });
    expect(fetcher).not.toHaveBeenCalled();

    const oversized = vi.fn<typeof fetch>(async () => fixtureResponse({ "content-length": "8193" }));
    await expect(
      prepareCloudNativeAnalysisPrerequisite({
        origin: "https://sample.test",
        query: defaultQuery,
        acceptsColumnar: true,
        fetch: oversized,
      }),
    ).rejects.toMatchObject({ code: "unsafe-materialization" });

    let cancelled = false;
    const chunked = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8_193));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(
      prepareCloudNativeAnalysisPrerequisite({
        origin: "https://sample.test",
        query: defaultQuery,
        acceptsColumnar: true,
        fetch: chunked,
      }),
    ).rejects.toMatchObject({ code: "unsafe-materialization" });
    expect(cancelled).toBe(true);
  });

  it("rejects changed fixture bytes and propagates cancellation as a structured prerequisite failure", async () => {
    const changedBytes = new Uint8Array(await (await fixtureResponse()).arrayBuffer());
    changedBytes[changedBytes.length - 2] ^= 1;
    const changed = vi.fn<typeof fetch>(async () => new Response(changedBytes, { status: 200 }));
    await expect(
      prepareCloudNativeAnalysisPrerequisite({
        origin: "https://sample.test",
        query: defaultQuery,
        acceptsColumnar: true,
        fetch: changed,
      }),
    ).rejects.toMatchObject({ code: "fixture-integrity" });

    const abort = new AbortController();
    const pending = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
            once: true,
          });
        }),
    );
    const preparation = prepareCloudNativeAnalysisPrerequisite({
      origin: "https://sample.test",
      query: defaultQuery,
      acceptsColumnar: true,
      fetch: pending,
      signal: abort.signal,
    });
    abort.abort();
    await expect(preparation).rejects.toMatchObject({ code: "aborted" });
  });

  it("pins fixture bytes and keeps the workflow module on published SDK imports", async () => {
    const fixture = await readFile(fixtureFile);
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(CLOUD_NATIVE_ANALYSIS_FIXTURE_SHA256);

    const source = await readFile(moduleFile, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["@honua/sdk-js/query-planner"]);
    expect(source).not.toContain("../../src/");
    expect(source).not.toContain("../../../src/");
  });
});
