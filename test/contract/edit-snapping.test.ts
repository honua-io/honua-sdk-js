import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentApi,
  type Capabilities,
  DEFAULT_SNAPPING_CONFIG,
  type SnapIndex,
  type SnapQueryInput,
  type SnapScreenPoint,
  type Source,
  type SourceDescriptor,
  capabilities,
  createEditSketchWorkflow,
  createSnapIndex,
  createSnapIndexEditSessionHooks,
  resolveSnapCandidate,
  resolveSnappingConfig,
  withSnappedActiveVertex,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";

/** Identity projection: geographic units are screen pixels. */
const project = (position: readonly [number, number]): SnapScreenPoint => ({ x: position[0], y: position[1] });

function query(x: number, y: number): SnapQueryInput {
  return { point: { x, y }, position: [x, y], project };
}

const ENABLED = { enabled: true, tolerance: 10 };

describe("contract / snapping config", () => {
  it("resolves defaults and merges partial input", () => {
    expect(resolveSnappingConfig()).toEqual({
      enabled: true,
      tolerance: 12,
      kinds: ["vertex", "edge"],
      sources: {},
    });
    expect(resolveSnappingConfig({ tolerance: 4, kinds: ["vertex"], sources: { roads: false } })).toEqual({
      enabled: true,
      tolerance: 4,
      kinds: ["vertex"],
      sources: { roads: false },
    });
    expect(DEFAULT_SNAPPING_CONFIG.kinds).toEqual(["vertex", "edge"]);
  });
});

describe("contract / snap candidate resolution", () => {
  it("snaps to the nearest vertex with vertex ordinal and screen distance", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [100, 0],
            [100, 100],
          ],
        },
      },
    ]);

    const resolution = resolveSnapCandidate(index, query(103, 104), ENABLED);
    expect(resolution.snapped).toBe(true);
    expect(resolution.candidate).toMatchObject({
      kind: "vertex",
      sourceId: "roads",
      featureId: 1,
      position: [100, 100],
      vertexIndex: 2,
      distance: 5,
    });
  });

  it("snaps to the nearest point on an edge with segment ordinal", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 7,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [100, 0],
          ],
        },
      },
    ]);

    const resolution = resolveSnapCandidate(index, query(50, 6), ENABLED);
    expect(resolution.candidate).toMatchObject({
      kind: "edge",
      featureId: 7,
      segmentIndex: 0,
      position: [50, 0],
      distance: 6,
    });
  });

  it("prefers vertex over edge at equal distance", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [100, 0],
          ],
        },
      },
    ]);

    // Directly above the endpoint vertex: the vertex and the segment's closest
    // point are the same location, so distances tie exactly.
    const resolution = resolveSnapCandidate(index, query(0, 8), ENABLED);
    expect(resolution.candidate?.kind).toBe("vertex");
    expect(resolution.candidates.map((c) => c.kind)).toEqual(["vertex", "edge"]);
    expect(resolution.candidates[0].distance).toBe(resolution.candidates[1].distance);
  });

  it("snaps candidates at exactly the tolerance and rejects beyond it", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("points", [{ id: 1, geometry: { type: "Point", coordinates: [0, 0] } }]);

    expect(resolveSnapCandidate(index, query(10, 0), ENABLED).snapped).toBe(true);
    expect(resolveSnapCandidate(index, query(10.01, 0), ENABLED).snapped).toBe(false);
  });

  it("breaks exact-distance ties by source id, then feature id, then ordinal", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("b-source", [{ id: 1, geometry: { type: "Point", coordinates: [4, 0] } }]);
    index.setSourceFeatures("a-source", [{ id: 9, geometry: { type: "Point", coordinates: [-4, 0] } }]);

    const bySource = resolveSnapCandidate(index, query(0, 0), ENABLED);
    expect(bySource.candidates.map((c) => c.sourceId)).toEqual(["a-source", "b-source"]);

    const byFeature = createSnapIndex();
    byFeature.setSourceFeatures("pts", [
      { id: 12, geometry: { type: "Point", coordinates: [4, 0] } },
      { id: 2, geometry: { type: "Point", coordinates: [-4, 0] } },
    ]);
    const featureTie = resolveSnapCandidate(byFeature, query(0, 0), ENABLED);
    expect(featureTie.candidates.map((c) => c.featureId)).toEqual([2, 12]);

    const byOrdinal = createSnapIndex();
    byOrdinal.setSourceFeatures("pts", [
      {
        id: 1,
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [4, 0],
            [-4, 0],
          ],
        },
      },
    ]);
    const ordinalTie = resolveSnapCandidate(byOrdinal, query(0, 0), ENABLED);
    expect(ordinalTie.candidates.map((c) => c.vertexIndex)).toEqual([0, 1]);
  });

  it("is deterministic across repeated resolutions and insertion orders", () => {
    const forward = createSnapIndex();
    forward.setSourceFeatures("a", [{ id: 1, geometry: { type: "Point", coordinates: [3, 0] } }]);
    forward.setSourceFeatures("b", [{ id: 2, geometry: { type: "Point", coordinates: [-3, 0] } }]);
    const reversed = createSnapIndex();
    reversed.setSourceFeatures("b", [{ id: 2, geometry: { type: "Point", coordinates: [-3, 0] } }]);
    reversed.setSourceFeatures("a", [{ id: 1, geometry: { type: "Point", coordinates: [3, 0] } }]);

    const first = resolveSnapCandidate(forward, query(0, 0), ENABLED);
    const second = resolveSnapCandidate(reversed, query(0, 0), ENABLED);
    expect(first.candidate).toEqual(second.candidate);
    expect(first.candidates).toEqual(second.candidates);
  });

  it("honours per-source enablement and per-source kind overrides", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [100, 0],
          ],
        },
      },
    ]);
    index.setSourceFeatures("parcels", [
      {
        id: 2,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 1],
            [100, 1],
          ],
        },
      },
    ]);

    const disabled = resolveSnapCandidate(index, query(50, 0), {
      ...ENABLED,
      sources: { roads: false, parcels: false },
    });
    expect(disabled.snapped).toBe(false);

    const roadsOnly = resolveSnapCandidate(index, query(50, 0), { ...ENABLED, sources: { parcels: false } });
    expect(roadsOnly.candidates.every((c) => c.sourceId === "roads")).toBe(true);

    const vertexOnlyRoads = resolveSnapCandidate(index, query(50, 0), {
      ...ENABLED,
      sources: { roads: { kinds: ["vertex"] }, parcels: false },
    });
    expect(vertexOnlyRoads.candidates.every((c) => c.kind === "vertex")).toBe(true);
  });

  it("filters candidate kinds globally", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [100, 0],
          ],
        },
      },
    ]);

    const edgeOnly = resolveSnapCandidate(index, query(2, 3), { ...ENABLED, kinds: ["edge"] });
    expect(edgeOnly.candidates.every((c) => c.kind === "edge")).toBe(true);
    const vertexOnly = resolveSnapCandidate(index, query(2, 3), { ...ENABLED, kinds: ["vertex"] });
    expect(vertexOnly.candidates.every((c) => c.kind === "vertex")).toBe(true);
  });

  it("resolves feature-body candidates inside polygons at zero distance", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("parcels", [
      {
        id: 5,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [100, 0],
              [100, 100],
              [0, 100],
              [0, 0],
            ],
          ],
        },
      },
    ]);

    const inside = resolveSnapCandidate(index, query(50, 50), { ...ENABLED, kinds: ["feature"] });
    expect(inside.candidate).toMatchObject({ kind: "feature", featureId: 5, position: [50, 50], distance: 0 });

    // Without the feature kind, the deep interior does not snap at all.
    expect(resolveSnapCandidate(index, query(50, 50), ENABLED).snapped).toBe(false);

    // Near the boundary, vertex and edge candidates outrank the feature body.
    const nearCorner = resolveSnapCandidate(index, query(2, 2), { ...ENABLED, kinds: ["vertex", "edge", "feature"] });
    expect(nearCorner.candidate?.kind).toBe("feature");
    expect(nearCorner.candidate?.distance).toBe(0);
    const nearEdgeOutside = resolveSnapCandidate(index, query(50, -4), {
      ...ENABLED,
      kinds: ["vertex", "edge", "feature"],
    });
    expect(nearEdgeOutside.candidate?.kind).toBe("edge");
  });

  it("respects polygon holes for feature-body containment", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("parcels", [
      {
        id: 5,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [100, 0],
              [100, 100],
              [0, 100],
              [0, 0],
            ],
            [
              [40, 40],
              [60, 40],
              [60, 60],
              [40, 60],
              [40, 40],
            ],
          ],
        },
      },
    ]);
    expect(resolveSnapCandidate(index, query(50, 50), { ...ENABLED, tolerance: 2, kinds: ["feature"] }).snapped).toBe(
      false,
    );
    expect(resolveSnapCandidate(index, query(20, 20), { ...ENABLED, tolerance: 2, kinds: ["feature"] }).snapped).toBe(
      true,
    );
  });

  it("returns unsnapped when disabled or nothing is within tolerance", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("points", [{ id: 1, geometry: { type: "Point", coordinates: [0, 0] } }]);

    expect(resolveSnapCandidate(index, query(1, 1), { ...ENABLED, enabled: false })).toEqual({
      snapped: false,
      candidates: [],
    });
    expect(resolveSnapCandidate(index, query(500, 500), ENABLED).snapped).toBe(false);
    expect(resolveSnapCandidate(createSnapIndex(), query(0, 0), ENABLED).snapped).toBe(false);
  });
});

describe("contract / snap index invalidation", () => {
  it("rebuilds the grid lazily after mutations", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("points", [{ id: 1, geometry: { type: "Point", coordinates: [0, 0] } }]);
    expect(index.stats().gridBuilds).toBe(0);

    resolveSnapCandidate(index, query(1, 1), ENABLED);
    resolveSnapCandidate(index, query(2, 2), ENABLED);
    expect(index.stats().gridBuilds).toBe(1);

    index.upsertFeature("points", { id: 2, geometry: { type: "Point", coordinates: [50, 50] } });
    resolveSnapCandidate(index, query(51, 51), ENABLED);
    expect(index.stats().gridBuilds).toBe(2);
  });

  it("reflects upserts, removals, and source replacement in resolution", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("points", [{ id: 1, geometry: { type: "Point", coordinates: [0, 0] } }]);
    expect(resolveSnapCandidate(index, query(1, 0), ENABLED).snapped).toBe(true);

    const previous = index.upsertFeature("points", { id: 1, geometry: { type: "Point", coordinates: [200, 200] } });
    expect(previous).toEqual({ id: 1, geometry: { type: "Point", coordinates: [0, 0] } });
    expect(resolveSnapCandidate(index, query(1, 0), ENABLED).snapped).toBe(false);
    expect(resolveSnapCandidate(index, query(201, 200), ENABLED).snapped).toBe(true);

    const removed = index.removeFeature("points", 1);
    expect(removed?.id).toBe(1);
    expect(resolveSnapCandidate(index, query(201, 200), ENABLED).snapped).toBe(false);

    index.setSourceFeatures("points", [{ id: 3, geometry: { type: "Point", coordinates: [9, 9] } }]);
    expect(resolveSnapCandidate(index, query(9, 9), ENABLED).candidate?.featureId).toBe(3);

    index.removeSource("points");
    expect(index.sourceIds()).toEqual([]);
    expect(resolveSnapCandidate(index, query(9, 9), ENABLED).snapped).toBe(false);
  });

  it("tracks stats over sources, features, vertices, and segments", () => {
    const index = createSnapIndex();
    index.setSourceFeatures("roads", [
      {
        id: 1,
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      },
    ]);
    index.setSourceFeatures("points", [{ id: 2, geometry: { type: "Point", coordinates: [5, 5] } }]);
    expect(index.stats()).toMatchObject({ sourceCount: 2, featureCount: 2, vertexCount: 4, segmentCount: 2 });
  });
});

describe("contract / snap index edit-session lifecycle hooks", () => {
  const parcelGeometry = { type: "Point", coordinates: [10, 10] };

  function seededIndex(): SnapIndex {
    const index = createSnapIndex();
    index.setSourceFeatures("parcels", [{ id: 10, geometry: parcelGeometry }]);
    return index;
  }

  it("upserts on optimistic apply and restores the previous entry on rollback", async () => {
    const index = seededIndex();
    const hooks = createSnapIndexEditSessionHooks(index);
    const workflow = createEditSketchWorkflow({
      source: makeSource({
        applyEdits: async () => ({
          added: [],
          updated: [{ id: 10, success: false, error: { code: 500, description: "boom" } }],
          deleted: [],
        }),
      }),
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "open", version: 1 }, geometry: parcelGeometry },
      optimistic: hooks,
    });

    workflow.setSketchGeometry("point", { type: "Point", coordinates: [60, 60] });
    const result = await workflow.submit();
    expect(result.status).toBe("failed");
    expect(result.optimistic).toEqual({ applied: true, rolledBack: true });

    // Rollback restored the pre-edit geometry in the index.
    expect(resolveSnapCandidate(index, query(10, 10), ENABLED).candidate?.featureId).toBe(10);
    expect(resolveSnapCandidate(index, query(60, 60), ENABLED).snapped).toBe(false);
  });

  it("keeps the applied entry on successful commit", async () => {
    const index = seededIndex();
    const workflow = createEditSketchWorkflow({
      source: makeSource(),
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "open", version: 1 }, geometry: parcelGeometry },
      optimistic: createSnapIndexEditSessionHooks(index),
    });

    workflow.setSketchGeometry("point", { type: "Point", coordinates: [60, 60] });
    const result = await workflow.submit();
    expect(result.status).toBe("succeeded");
    expect(resolveSnapCandidate(index, query(60, 60), ENABLED).candidate?.featureId).toBe(10);
    expect(resolveSnapCandidate(index, query(10, 10), ENABLED).snapped).toBe(false);
  });

  it("removes deleted features on apply and restores them on rollback", async () => {
    const index = seededIndex();
    const hooks = createSnapIndexEditSessionHooks(index);
    const snapshot = {
      sourceId: "parcels",
      protocol: "geoservices-feature-service",
      kind: "delete",
      feature: { id: 10, attributes: {} },
      attachments: [],
      metadata: { fields: [], relationships: [], attachments: "unsupported", conflict: { state: "unsupported" } },
    } as never;

    await hooks.apply?.(snapshot);
    expect(resolveSnapCandidate(index, query(10, 10), ENABLED).snapped).toBe(false);
    await hooks.rollback?.(snapshot, {} as never);
    expect(resolveSnapCandidate(index, query(10, 10), ENABLED).snapped).toBe(true);
  });

  it("delegates to composed inner hooks", async () => {
    const inner = { apply: vi.fn(), rollback: vi.fn(), commit: vi.fn() };
    const hooks = createSnapIndexEditSessionHooks(seededIndex(), { inner });
    const snapshot = {
      sourceId: "parcels",
      kind: "update",
      feature: { id: 10, attributes: {}, geometry: parcelGeometry },
      attachments: [],
    } as never;
    await hooks.apply?.(snapshot);
    await hooks.commit?.(snapshot, {} as never);
    expect(inner.apply).toHaveBeenCalledOnce();
    expect(inner.commit).toHaveBeenCalledOnce();
  });
});

describe("contract / withSnappedActiveVertex", () => {
  it("replaces the coordinate of a Point", () => {
    expect(withSnappedActiveVertex({ type: "Point", coordinates: [1, 2] }, [3, 4])).toEqual({
      type: "Point",
      coordinates: [3, 4],
    });
  });

  it("replaces the last coordinate of a LineString", () => {
    expect(
      withSnappedActiveVertex(
        {
          type: "LineString",
          coordinates: [
            [0, 0],
            [5, 5],
          ],
        },
        [6, 6],
      ),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [6, 6],
      ],
    });
  });

  it("replaces the last non-closing vertex of a closed Polygon ring", () => {
    const polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 0],
        ],
      ],
    };
    expect(withSnappedActiveVertex(polygon, [9, 9])).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [9, 9],
          [0, 0],
        ],
      ],
    });
    // The input is not mutated.
    expect(polygon.coordinates[0][2]).toEqual([10, 10]);
  });

  it("returns unknown or null geometry unchanged", () => {
    expect(withSnappedActiveVertex(null, [1, 1])).toBeNull();
    const unknown = { type: "Weird", coordinates: 4 };
    expect(withSnappedActiveVertex(unknown, [1, 1])).toBe(unknown);
  });
});

describe("contract / snap lookup micro-benchmark", () => {
  it("resolves pointer moves in well under 5ms each at 10k indexed vertices", () => {
    const index = createSnapIndex();
    // 100 LineStrings x 100 vertices = 10,000 vertices (+ 9,900 segments).
    const features = Array.from({ length: 100 }, (_, f) => ({
      id: f,
      geometry: {
        type: "LineString",
        coordinates: Array.from({ length: 100 }, (_, v) => [(f % 10) * 100 + v, Math.floor(f / 10) * 100 + (v % 7)]),
      },
    }));
    index.setSourceFeatures("bench", features);
    expect(index.stats().vertexCount).toBe(10_000);

    // Warm-up triggers the one-time lazy grid build.
    resolveSnapCandidate(index, query(500, 500), ENABLED);

    const lookups = 200;
    const start = performance.now();
    let snapped = 0;
    for (let i = 0; i < lookups; i += 1) {
      const x = (i * 37) % 1000;
      const y = (i * 53) % 700;
      if (resolveSnapCandidate(index, query(x, y), ENABLED).snapped) snapped += 1;
    }
    const elapsed = performance.now() - start;
    expect(snapped).toBeGreaterThan(0);
    // NFR-001 targets 2ms/lookup; assert a CI-safe 5ms average bound.
    expect(elapsed / lookups).toBeLessThan(5);
  });
});

// ── Fakes ─────────────────────────────────────────────────────

type ParcelDraft = Record<string, unknown>;

const PARCEL_FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", nullable: false, editable: false },
  { name: "status", type: "esriFieldTypeString", nullable: true, editable: true, length: 12 },
  { name: "version", type: "esriFieldTypeInteger", nullable: true, editable: true },
] as const;

function makeSource(
  options: {
    capabilities?: Capabilities;
    applyEdits?: Source<ParcelDraft>["applyEdits"];
  } = {},
): Source<ParcelDraft> {
  const descriptor: SourceDescriptor = {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
    capabilities: options.capabilities ?? capabilities(["query", "applyEdits"]),
    schema: { primaryKey: "OBJECTID", fields: PARCEL_FIELDS },
  };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    async query() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAll() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAggregate() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryExtent() {
      return { extent: null };
    },
    stream() {
      return emptyResultStream();
    },
    async queryObjectIds() {
      return [];
    },
    applyEdits: options.applyEdits ?? (async () => ({ added: [], updated: [{ id: 10, success: true }], deleted: [] })),
    async queryRelated(request) {
      return { groups: request.sourceIds.map((sourceId) => ({ sourceId, features: [] })) };
    },
    attachments: unsupportedAttachments(),
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  };
}

async function* emptyResultStream() {
  // never yields
}

function unsupportedAttachments(): AttachmentApi {
  const fail = () => {
    throw new HonuaCapabilityNotSupportedError("attachments", "geoservices-feature-service", "parcels");
  };
  return { query: fail, list: fail, add: fail, update: fail, delete: fail };
}
