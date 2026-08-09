import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  type ColumnarResponseDecoderContext,
  type ColumnarWorkflowBudgets,
  ColumnarWorkflowError,
  createApacheArrowResponseDecoder,
} from "../src/columnar-workflow/index.js";
import { decodeGeoArrowBatch, inspectGeoArrowBatch } from "../src/columnar/index.js";

const fixtureUrl = new URL("./fixtures/columnar/honua-server-geoarrow-wkb.arrow", import.meta.url);
const manifestUrl = new URL("./fixtures/columnar/honua-server-geoarrow-wkb.manifest.json", import.meta.url);
const fixture = await readFile(fixtureUrl);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
  readonly producer: { readonly commit: string };
  readonly artifact: { readonly bytes: number; readonly sha256: string };
};

const budgets: ColumnarWorkflowBudgets = {
  maxRows: 100,
  maxBatches: 4,
  maxTransferBytes: 1024 * 1024,
  maxBackingBytes: 1024 * 1024,
};

const context = (overrides: Partial<ColumnarResponseDecoderContext> = {}): ColumnarResponseDecoderContext => ({
  source: {
    kind: "honua-feature-query",
    id: "honua-arrow-fixture",
    baseUrl: "https://example.test/",
    serviceId: "Places",
    layerId: 0,
    format: "arrow",
    sourceVersion: manifest.producer.commit,
    schemaVersion: "places-v1",
    authorizationScope: "public",
  },
  query: { columns: ["name", "created"], limit: 10, orderBy: [{ field: "created", direction: "asc" }] },
  response: new Response(fixture, {
    headers: {
      "content-length": String(fixture.byteLength),
      "content-type": "application/vnd.apache.arrow.stream",
    },
  }),
  budgets,
  identity: {
    sourceId: "honua-arrow-fixture",
    sourceVersion: manifest.producer.commit,
    schemaVersion: "places-v1",
    authorizationScope: "public",
  },
  ...overrides,
});

const decode = async (input: ColumnarResponseDecoderContext) => {
  const batches = [];
  for await (const batch of createApacheArrowResponseDecoder()(input)) batches.push(batch);
  return batches;
};

test("decodes an exact Honua Server geoarrow.wkb IPC fixture into the normative bounded batch", async () => {
  assert.equal(fixture.byteLength, manifest.artifact.bytes);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), manifest.artifact.sha256);
  const batches = await decode(context());
  assert.equal(batches.length, 1);
  const batch = batches[0]!;
  const inspection = inspectGeoArrowBatch(batch);
  assert.equal(batch.rowOffset, 0);
  assert.equal(batch.identity?.sourceVersion, manifest.producer.commit);
  assert.equal(batch.identity?.ordering.stable, true);
  assert.equal(inspection.geometry.kind, "point");
  assert.equal(inspection.geometry.crs, "OGC:CRS84");
  assert.equal(inspection.featureIds?.field, "objectid");
  assert.equal(inspection.dictionary?.field, "name");
  assert.equal(inspection.temporal?.field, "created");
  assert.deepEqual(decodeGeoArrowBatch(batch).rows, [
    {
      geometry: [-157.8583, 21.3069],
      timestamp: 1704164645000n,
      dictionaryValue: "Honolulu Harbor",
      featureId: 1,
    },
  ]);
});

test("applies transfer, row, backing, and cancellation ceilings before emitting a batch", async () => {
  await assert.rejects(
    async () => decode(context({ budgets: { ...budgets, maxTransferBytes: fixture.byteLength - 1 } })),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "TRANSFER_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    async () => decode(context({ budgets: { ...budgets, maxRows: 0 } })),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ROW_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    async () => decode(context({ budgets: { ...budgets, maxBackingBytes: 8 } })),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "BACKING_LIMIT_EXCEEDED",
  );
  const controller = new AbortController();
  controller.abort("test cancellation");
  await assert.rejects(
    async () => decode(context({ signal: controller.signal })),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "ABORTED",
  );
});
