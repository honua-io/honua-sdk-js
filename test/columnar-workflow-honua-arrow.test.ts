import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as arrow from "apache-arrow";
import { test } from "vitest";

import { HonuaArrowWkbError, decodeHonuaArrowWkbRecordBatch } from "../src/columnar-workflow/honua-arrow-wkb.js";
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

const context = (
  overrides: Partial<ColumnarResponseDecoderContext> = {},
  payload: Uint8Array = fixture,
): ColumnarResponseDecoderContext => {
  const responseBody = new ArrayBuffer(payload.byteLength);
  new Uint8Array(responseBody).set(payload);
  return {
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
    response: new Response(responseBody, {
      headers: {
        "content-length": String(payload.byteLength),
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
  };
};

const fullIdentity = () => ({
  ...context().identity,
  planId: "synthetic-arrow",
  ordering: { stable: false as const, keys: [] },
  freshness: { observedAt: "2026-08-09T00:00:00.000Z" },
});

const decode = async (input: ColumnarResponseDecoderContext) => {
  const batches = [];
  for await (const batch of createApacheArrowResponseDecoder()(input)) batches.push(batch);
  return batches;
};

type WkbDimensions = "xy" | "xyz" | "xym" | "xyzm";

interface WkbOptions {
  readonly littleEndian?: boolean;
  readonly dimensions?: WkbDimensions;
  readonly flavor?: "iso" | "ewkb";
  readonly srid?: number;
}

const dimensionWidth = (dimensions: WkbDimensions): number => (dimensions === "xy" ? 2 : dimensions === "xyzm" ? 4 : 3);

const writeWkbHeader = (view: DataView, baseType: number, options: WkbOptions): number => {
  const littleEndian = options.littleEndian ?? true;
  const dimensions = options.dimensions ?? "xy";
  const flavor = options.flavor ?? "iso";
  view.setUint8(0, littleEndian ? 1 : 0);
  let type = baseType;
  if (flavor === "iso") {
    type += dimensions === "xyz" ? 1000 : dimensions === "xym" ? 2000 : dimensions === "xyzm" ? 3000 : 0;
  } else {
    if (dimensions === "xyz" || dimensions === "xyzm") type |= 0x8000_0000;
    if (dimensions === "xym" || dimensions === "xyzm") type |= 0x4000_0000;
    if (options.srid !== undefined) type |= 0x2000_0000;
  }
  view.setUint32(1, type >>> 0, littleEndian);
  if (flavor === "ewkb" && options.srid !== undefined) {
    view.setUint32(5, options.srid, littleEndian);
    return 9;
  }
  return 5;
};

const wkbHeaderBytes = (options: WkbOptions): number =>
  options.flavor === "ewkb" && options.srid !== undefined ? 9 : 5;

const pointWkb = (coordinates: readonly number[], options: WkbOptions = {}): Uint8Array => {
  const width = dimensionWidth(options.dimensions ?? "xy");
  assert.equal(coordinates.length, width);
  const bytes = new Uint8Array(wkbHeaderBytes(options) + width * 8);
  const view = new DataView(bytes.buffer);
  let offset = writeWkbHeader(view, 1, options);
  for (const coordinate of coordinates) {
    view.setFloat64(offset, coordinate, options.littleEndian ?? true);
    offset += 8;
  }
  return bytes;
};

const lineStringWkb = (positions: readonly (readonly number[])[], options: WkbOptions = {}): Uint8Array => {
  const width = dimensionWidth(options.dimensions ?? "xy");
  const bytes = new Uint8Array(wkbHeaderBytes(options) + 4 + positions.length * width * 8);
  const view = new DataView(bytes.buffer);
  const littleEndian = options.littleEndian ?? true;
  let offset = writeWkbHeader(view, 2, options);
  view.setUint32(offset, positions.length, littleEndian);
  offset += 4;
  for (const position of positions) {
    assert.equal(position.length, width);
    for (const coordinate of position) {
      view.setFloat64(offset, coordinate, littleEndian);
      offset += 8;
    }
  }
  return bytes;
};

const polygonWkb = (rings: readonly (readonly (readonly number[])[])[], options: WkbOptions = {}): Uint8Array => {
  const width = dimensionWidth(options.dimensions ?? "xy");
  const vertexCount = rings.reduce((total, ring) => total + ring.length, 0);
  const bytes = new Uint8Array(wkbHeaderBytes(options) + 4 + rings.length * 4 + vertexCount * width * 8);
  const view = new DataView(bytes.buffer);
  const littleEndian = options.littleEndian ?? true;
  let offset = writeWkbHeader(view, 3, options);
  view.setUint32(offset, rings.length, littleEndian);
  offset += 4;
  for (const ring of rings) {
    view.setUint32(offset, ring.length, littleEndian);
    offset += 4;
    for (const position of ring) {
      assert.equal(position.length, width);
      for (const coordinate of position) {
        view.setFloat64(offset, coordinate, littleEndian);
        offset += 8;
      }
    }
  }
  return bytes;
};

const unsupportedWkb = (type: number): Uint8Array => {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, type, true);
  return bytes;
};

interface SyntheticIpcOptions {
  readonly storage?: "binary" | "large-binary";
  readonly extensionMetadata?: string | Readonly<Record<string, unknown>>;
}

const syntheticIpc = async (
  geometries: readonly (Uint8Array | null)[],
  options: SyntheticIpcOptions = {},
): Promise<Uint8Array> => {
  const type = options.storage === "large-binary" ? new arrow.LargeBinary() : new arrow.Binary();
  const vector = arrow.vectorFromArray(geometries, type);
  const source = new arrow.Table({ geometry: vector }).batches[0]!;
  const metadata = new Map<string, string>([["ARROW:extension:name", "geoarrow.wkb"]]);
  if (options.extensionMetadata !== undefined) {
    metadata.set(
      "ARROW:extension:metadata",
      typeof options.extensionMetadata === "string"
        ? options.extensionMetadata
        : JSON.stringify(options.extensionMetadata),
    );
  }
  const recordBatch = new arrow.RecordBatch(
    new arrow.Schema([new arrow.Field("geometry", type, true, metadata)]),
    source.data,
  );
  return arrow.RecordBatchStreamWriter.writeAll([recordBatch]).toUint8Array();
};

const decodeSynthetic = async (geometries: readonly (Uint8Array | null)[], options: SyntheticIpcOptions = {}) => {
  const payload = await syntheticIpc(geometries, options);
  const batches = await decode(context({ query: { limit: 10 } }, payload));
  assert.equal(batches.length, 1);
  return batches[0]!;
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
  assert.equal(inspection.geometry.crs, undefined);
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

test("preserves bounded GeoArrow CRS and edges metadata across Binary and LargeBinary storage", async () => {
  for (const storage of ["binary", "large-binary"] as const) {
    const batch = await decodeSynthetic([pointWkb([1, 2])], {
      storage,
      extensionMetadata: { crs: "EPSG:4326", crs_type: "authority_code", edges: "spherical" },
    });
    const geometry = inspectGeoArrowBatch(batch).geometry;
    assert.equal(geometry.crs, "EPSG:4326");
    assert.equal(geometry.crsType, "authority_code");
    assert.equal(geometry.edges, "spherical");
  }

  const projjson = { type: "GeographicCRS", name: "WGS 84" };
  const projjsonGeometry = inspectGeoArrowBatch(
    await decodeSynthetic([pointWkb([3, 4])], {
      extensionMetadata: { crs: projjson, crs_type: "projjson" },
    }),
  ).geometry;
  assert.deepEqual(JSON.parse(JSON.stringify(projjsonGeometry.crs)), projjson);
  assert.equal(projjsonGeometry.crsType, "projjson");
  assert.equal(projjsonGeometry.edges, "planar");

  for (const edges of ["vincenty", "thomas", "andoyer", "karney"] as const) {
    assert.equal(
      inspectGeoArrowBatch(await decodeSynthetic([pointWkb([5, 6])], { extensionMetadata: { edges } })).geometry.edges,
      edges,
    );
  }
});

test("requires declared CRS metadata when WKB values mix embedded and missing SRIDs", async () => {
  const geometries = [
    pointWkb([1, 2, 3], { littleEndian: false, dimensions: "xyz" }),
    pointWkb([4, 5, 6], { dimensions: "xyz", flavor: "ewkb", srid: 4326 }),
  ];
  await assert.rejects(() => decodeSynthetic(geometries), /mix embedded and missing SRIDs/);

  const batch = await decodeSynthetic(geometries, {
    extensionMetadata: { crs: "EPSG:4326", crs_type: "authority_code" },
  });
  assert.deepEqual(
    decodeGeoArrowBatch(batch).rows.map(({ geometry }) => geometry),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  );
  assert.equal(inspectGeoArrowBatch(batch).geometry.crs, "EPSG:4326");
  assert.equal(inspectGeoArrowBatch(batch).geometry.crsType, "authority_code");
});

test("preserves null and empty Point, LineString, and Polygon semantics", async () => {
  const points = decodeGeoArrowBatch(
    await decodeSynthetic([pointWkb([Number.NaN, Number.NaN]), null, pointWkb([1, 2])], {
      extensionMetadata: { geometry_types: ["Point"] },
    }),
  ).rows;
  assert.ok(Array.isArray(points[0]!.geometry));
  assert.ok((points[0]!.geometry as readonly number[]).every(Number.isNaN));
  assert.equal(points[1]!.geometry, null);
  assert.deepEqual(points[2]!.geometry, [1, 2]);

  assert.deepEqual(
    decodeGeoArrowBatch(
      await decodeSynthetic([
        lineStringWkb([]),
        lineStringWkb([
          [0, 0],
          [1, 1],
        ]),
      ]),
    ).rows.map(({ geometry }) => geometry),
    [
      [],
      [
        [0, 0],
        [1, 1],
      ],
    ],
  );
  assert.deepEqual(
    decodeGeoArrowBatch(
      await decodeSynthetic([
        polygonWkb([]),
        polygonWkb([
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ]),
      ]),
    ).rows.map(({ geometry }) => geometry),
    [
      [],
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    ],
  );
});

test("rejects malformed metadata and intentionally unsupported WKB layouts", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly geometries: readonly Uint8Array[];
    readonly options?: SyntheticIpcOptions;
  }> = [
    { name: "present-empty extension metadata", geometries: [pointWkb([1, 2])], options: { extensionMetadata: "" } },
    {
      name: "non-object extension metadata",
      geometries: [pointWkb([1, 2])],
      options: { extensionMetadata: "[]" },
    },
    {
      name: "crs_type without crs",
      geometries: [pointWkb([1, 2])],
      options: { extensionMetadata: { crs_type: "authority_code" } },
    },
    {
      name: "invalid crs_type",
      geometries: [pointWkb([1, 2])],
      options: { extensionMetadata: { crs: "EPSG:4326", crs_type: "epsg" } },
    },
    {
      name: "invalid edges",
      geometries: [pointWkb([1, 2])],
      options: { extensionMetadata: { edges: "rhumb" } },
    },
    { name: "M", geometries: [pointWkb([1, 2, 3], { dimensions: "xym" })] },
    { name: "ZM", geometries: [pointWkb([1, 2, 3, 4], { dimensions: "xyzm", flavor: "ewkb" })] },
    { name: "MultiPoint", geometries: [unsupportedWkb(4)] },
    { name: "GeometryCollection", geometries: [unsupportedWkb(7)] },
    { name: "mixed kinds", geometries: [pointWkb([1, 2]), lineStringWkb([])] },
    { name: "mixed dimensions", geometries: [pointWkb([1, 2]), pointWkb([1, 2, 3], { dimensions: "xyz" })] },
    { name: "partial-NaN Point", geometries: [pointWkb([Number.NaN, 2])] },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => decodeSynthetic(item.geometries, item.options),
      (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "INVALID_RESPONSE",
      item.name,
    );
  }
});

test("reports BinaryView as an explicit Apache Arrow JS runtime limitation", () => {
  const recordBatch = {
    numRows: 1,
    schema: {
      fields: [
        {
          name: "geometry",
          type: { toString: () => "BinaryView" },
          metadata: new Map([["ARROW:extension:name", "geoarrow.wkb"]]),
        },
      ],
      metadata: new Map(),
    },
    getChildAt: () => ({ get: () => pointWkb([1, 2]) }),
  };
  assert.throws(
    () =>
      decodeHonuaArrowWkbRecordBatch({
        recordBatch,
        id: "binary-view",
        sequence: 0,
        schemaId: "binary-view-v1",
        identity: fullIdentity(),
        maxRows: 1,
        maxBackingBytes: 1024,
      }),
    (error: unknown) =>
      error instanceof HonuaArrowWkbError &&
      error.code === "unsupported-layout" &&
      error.message.includes("BinaryView"),
  );
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

test("cancels an unbounded response stream as soon as the transfer ceiling is crossed", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    async () =>
      decode(
        context({
          response: new Response(body),
          budgets: { ...budgets, maxTransferBytes: 5 },
        }),
      ),
    (error: unknown) => error instanceof ColumnarWorkflowError && error.code === "TRANSFER_LIMIT_EXCEEDED",
  );
  assert.equal(cancelled, true);
  assert.ok(pulls < 10);
});

test("propagates an embedded EWKB SRID instead of mislabeling its coordinates", () => {
  const ewkb = new Uint8Array(25);
  const view = new DataView(ewkb.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 0x2000_0001, true);
  view.setUint32(5, 3857, true);
  view.setFloat64(9, -17_575_317, true);
  view.setFloat64(17, 2_427_237, true);
  const geometryMetadata = new Map([
    ["ARROW:extension:name", "geoarrow.wkb"],
    ["ARROW:extension:metadata", JSON.stringify({ geometry_types: ["Point"] })],
  ]);
  const recordBatch = {
    numRows: 1,
    schema: { fields: [{ name: "geometry", type: "Binary", metadata: geometryMetadata }] },
    getChildAt: (index: number) => (index === 0 ? { get: () => ewkb } : null),
  };

  const batch = decodeHonuaArrowWkbRecordBatch({
    recordBatch,
    id: "ewkb-srid",
    sequence: 0,
    schemaId: "places-v1",
    identity: fullIdentity(),
    maxRows: 1,
    maxBackingBytes: 1024,
  });
  assert.equal(inspectGeoArrowBatch(batch).geometry.crs, "EPSG:3857");
  assert.equal(inspectGeoArrowBatch(batch).geometry.crsType, "authority_code");
});
