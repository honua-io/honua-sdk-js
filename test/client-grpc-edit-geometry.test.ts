import { create, fromBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import { ApplyEditsRequestSchema, ApplyEditsResponseSchema, GeometrySchema } from "../src/gen/geospatial/v1/index.js";
import { queryResponse, response } from "./helpers/grpc-edit-wire.js";
const target = { serviceId: "parcels", layerId: 0 };

function roundtripFetch(
  coords: { x: number; y: number; z?: number; m?: number }[],
  shape: "multiPoint" | "polyline" | "polygon" | "multiPolygon",
) {
  const geometry = create(
    GeometrySchema,
    shape === "multiPoint"
      ? { shape: { case: "multiPoint", value: { points: coords } } }
      : shape === "polyline"
        ? { shape: { case: "polyline", value: { paths: [{ coords }] } } }
        : shape === "polygon"
          ? { shape: { case: "polygon", value: { rings: [{ coords }] } } }
          : { shape: { case: "multiPolygon", value: { polygons: [{ rings: [{ coords }] }] } } },
  );
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/QueryFeatures")) return queryResponse(geometry);
    expect(String(input)).toBe("https://example.test/geospatial.v1.FeatureService/ApplyEdits");
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    const encoded = wire.updates[0].geometry!;
    const coordinates =
      encoded.shape.case === "multiPoint"
        ? encoded.shape.value.points
        : encoded.shape.case === "polyline"
          ? encoded.shape.value.paths[0].coords
          : encoded.shape.case === "polygon"
            ? encoded.shape.value.rings[0].coords
            : [];
    expect(coordinates.map(({ z, m }) => ({ z, m }))).toEqual(coords.map(({ z, m }) => ({ z, m })));
    return response(create(ApplyEditsResponseSchema, { updateResults: [{ objectId: 1n, success: true }] }));
  });
  return fetchFn;
}

it.each([
  { shape: "points", hasZ: false },
  { shape: "paths", hasZ: false },
  { shape: "rings", hasZ: false },
  { shape: "points", hasZ: true },
  { shape: "paths", hasZ: true },
  { shape: "rings", hasZ: true },
])("preserves measured $shape coordinates with hasZ=$hasZ on the protobuf wire", async ({ shape, hasZ }) => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    const geometry = wire.adds[0].geometry!;
    const coordinates =
      geometry.shape.case === "multiPoint"
        ? geometry.shape.value.points
        : geometry.shape.case === "polyline"
          ? geometry.shape.value.paths[0].coords
          : geometry.shape.case === "polygon"
            ? geometry.shape.value.rings[0].coords
            : [];
    expect(coordinates).toHaveLength(2);
    expect(coordinates.map(({ z, m }) => ({ z, m }))).toEqual([
      { z: hasZ ? 10 : undefined, m: 100 },
      { z: hasZ ? 11 : undefined, m: 101 },
    ]);
    return response(create(ApplyEditsResponseSchema, { addResults: [{ objectId: 1n, success: true }] }));
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const coords = hasZ
    ? [
        [0, 0, 10, 100],
        [1, 1, 11, 101],
      ]
    : [
        [0, 0, 100],
        [1, 1, 101],
      ];
  await client.applyEdits({
    ...target,
    adds: [{ attributes: {}, geometry: { hasZ, hasM: true, [shape]: shape === "points" ? coords : [coords] } }],
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it.each(["multiPoint", "polyline", "polygon", "multiPolygon"] as const)(
  "preserves M-only %s through query and update protobuf messages",
  async (shape) => {
    const coords = [
      { x: 0, y: 1, m: 100 },
      { x: 2, y: 3, m: 101 },
    ];
    const fetchFn = roundtripFetch(coords, shape);
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
    const queried = await client.queryFeatures(target);
    expect(queried.features?.[0].geometry).toMatchObject({ hasZ: false, hasM: true });
    await client.applyEdits({ ...target, updates: queried.features });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  },
);

it.each(["multiPoint", "polyline", "polygon", "multiPolygon"] as const)(
  "preserves partially missing Z and M in %s through query and update protobuf messages",
  async (shape) => {
    const coords = [
      { x: 0, y: 1, z: 10, m: 100 },
      { x: 2, y: 3, m: 101 },
      { x: 4, y: 5, z: 12 },
      { x: 6, y: 7 },
    ];
    const fetchFn = roundtripFetch(coords, shape);
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
    const queried = await client.queryFeatures(target);
    expect(queried.features?.[0].geometry).toMatchObject({ hasZ: true, hasM: true });
    await client.applyEdits({ ...target, updates: JSON.parse(JSON.stringify(queried.features)) });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  },
);
