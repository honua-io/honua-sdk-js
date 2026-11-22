import { describe, expect, it } from "vitest";

import {
  HONUA_3D_SYMBOLOGY_KIND,
  HONUA_3D_SYMBOLOGY_VERSION,
  type Honua3DSymbologyV1,
  applyEntityStyleUpdate,
  applySceneEditProposal,
  approveSceneEditProposal,
  captureSceneBookmark,
  compile3DSymbologyToTilesetStyle,
  createSceneEditProposal,
  createSceneStore,
  evaluateEntitySymbology,
  formatMeasurementLabel,
  measureScenePositions,
  normalizeCesiumPick,
  parseSceneBookmark,
  pickNormalizedSceneFeature,
  reconcileSceneEditWithRealtime,
  requestElevationProfile,
  serializeSceneBookmark,
  validate3DSymbologyExpression,
} from "../src/scene-workspace/index.js";

describe("3D symbology contract, evaluation, compilation, and identity-preserving updates", () => {
  const symbology: Honua3DSymbologyV1 = {
    kind: HONUA_3D_SYMBOLOGY_KIND,
    version: HONUA_3D_SYMBOLOGY_VERSION,
    mode: "class-breaks",
    field: "height_m",
    defaultSymbol: { color: "#94a3b8", opacity: 0.85, pixelSize: 8, scale: 1 },
    classBreaks: [
      { minValue: 0, maxValue: 50, symbol: { color: "#22c55e", extrudedHeight: 30 } },
      { minValue: 50.01, maxValue: 200, symbol: { color: "#f97316", extrudedHeight: 120 } },
    ],
    visualVariables: [
      {
        channel: "size",
        field: "priority",
        stops: [
          { value: 0, size: 6 },
          { value: 10, size: 16 },
        ],
      },
    ],
    label: { field: "name" },
    scaleRange: { minDistanceMeters: 50, maxDistanceMeters: 5000 },
    selectionStyle: { color: "#facc15", outlineColor: "#ffffff", scaleMultiplier: 1.5 },
  };

  it("evaluates class-breaks, continuous visual variables, scale range, labels, and selection highlights", () => {
    const normal = evaluateEntitySymbology(
      symbology,
      { height_m: 80, priority: 5, name: "Tower A" },
      { cameraDistanceMeters: 400 },
    );
    expect(normal.color).toBe("#f97316");
    expect(normal.extrudedHeight).toBe(120);
    expect(normal.pixelSize).toBeCloseTo(11, 5);
    expect(normal.labelText).toBe("Tower A");
    expect(normal.visible).toBe(true);

    const selected = evaluateEntitySymbology(
      symbology,
      { height_m: 80, priority: 5, name: "Tower A" },
      { selected: true, cameraDistanceMeters: 400 },
    );
    expect(selected.color).toBe("#facc15");
    expect(selected.scale).toBeCloseTo(1.5, 5);
    expect(selected.highlighted).toBe(true);

    const hiddenByScale = evaluateEntitySymbology(symbology, { height_m: 80 }, { cameraDistanceMeters: 8000 });
    expect(hiddenByScale.visible).toBe(false);
  });

  it("rejects hostile expressions fail-closed and compiles safe descriptors onto Honua3DStyleSpec", () => {
    for (const hostile of [
      "eval('alert(1)')",
      "constructor.constructor('return process')()",
      "__proto__.polluted = true",
      "import('node:fs')",
      "`${height}`",
      "height = 10",
    ]) {
      const diag = validate3DSymbologyExpression(hostile);
      expect(diag?.code).toBe("symbology-expression-rejected");
    }

    const unsafeCompiled = compile3DSymbologyToTilesetStyle({
      ...symbology,
      filterExpression: "globalThis.pwn = 1",
    });
    expect(unsafeCompiled.spec).toBeUndefined();
    expect(unsafeCompiled.diagnostics.some((d) => d.code === "symbology-expression-rejected")).toBe(true);

    const unsupportedFilter = { ...symbology, filterExpression: "height_m > 50" };
    expect(compile3DSymbologyToTilesetStyle(unsupportedFilter).spec).toBeUndefined();
    expect(evaluateEntitySymbology(unsupportedFilter, { height_m: 80 })).toMatchObject({
      visible: false,
      diagnostics: [{ code: "symbology-filter-unsupported", severity: "error" }],
    });
    for (const symbol of [
      { ...symbology, classBreaks: [{ minValue: 0, maxValue: 100, symbol: { color: "red' + 'blue" } }] },
      { ...symbology, uniqueValues: [{ value: 80, symbol: { color: "red' + 'blue" } }] },
    ]) {
      expect(compile3DSymbologyToTilesetStyle(symbol)).toMatchObject({
        diagnostics: [{ code: "symbology-invalid-value", severity: "error" }],
      });
    }

    const compiled = compile3DSymbologyToTilesetStyle(symbology);
    expect(compiled.spec?.encoding).toBe("3d-tiles-styling");
    expect(compiled.spec?.style.color).toEqual({
      conditions: [
        ["${height_m} >= 0 && ${height_m} <= 50", "color('#22c55e', 0.85)"],
        ["${height_m} >= 50.01 && ${height_m} <= 200", "color('#f97316', 0.85)"],
        ["true", "color('#94a3b8', 0.85)"],
      ],
    });
  });

  it("updates mounted live Cesium entities in place, preserving object identity and selectedEntity", () => {
    const liveEntity = {
      id: "honua-parcels:n:42",
      show: true,
      properties: { height_m: { getValue: () => 25 }, name: "Lot 42" },
      point: { color: undefined as unknown, pixelSize: 4 },
      polygon: { material: undefined as unknown, extrudedHeight: 0 },
    };
    const viewer = { selectedEntity: liveEntity };
    const collection = {
      getById: (id: string) => (id === liveEntity.id ? liveEntity : undefined),
    };

    const first = applyEntityStyleUpdate({
      collection,
      entityIds: [liveEntity.id, "missing-id"],
      symbology,
      selectedIds: new Set([liveEntity.id]),
    });
    expect(first.updated).toEqual([liveEntity.id]);
    expect(first.missing).toEqual(["missing-id"]);
    expect(viewer.selectedEntity).toBe(liveEntity);
    expect(liveEntity.polygon.extrudedHeight).toBe(30);

    // Repeating the same update is a no-op (unchanged) and preserves identity.
    const second = applyEntityStyleUpdate({
      collection,
      entityIds: [liveEntity.id],
      symbology,
      selectedIds: new Set([liveEntity.id]),
    });
    expect(second.unchanged).toEqual([liveEntity.id]);
    expect(viewer.selectedEntity).toBe(liveEntity);
  });
});

describe("normalized 3D picking, measurement/profile provenance, and bookmark round-trip", () => {
  it("normalizes entities, 3D-Tiles features, point clouds, models, and unresolvable hits", () => {
    const entityPick = normalizeCesiumPick({
      id: {
        id: "honua-buildings:n:108",
        properties: { name: { getValue: () => "Civic Hall" }, floors: 12 },
      },
    });
    expect(entityPick.resolved).toBe(true);
    if (entityPick.resolved) {
      expect(entityPick.kind).toBe("entity");
      expect(entityPick.sourceId).toBeUndefined();
      expect(entityPick.featureId).toBe(108);
      expect(entityPick.selectionTarget).toBeUndefined();
      expect(entityPick.attributes.name).toBe("Civic Hall");
    }

    const tilesetPick = normalizeCesiumPick(
      {
        getPropertyIds: () => ["objectId", "zoning"],
        getProperty: (k: string) => (k === "objectId" ? 501 : "commercial"),
        tileset: { id: "city-3dtiles" },
      },
      { position: { longitude: -122.4, latitude: 37.78, height: 42 } },
    );
    expect(tilesetPick.resolved).toBe(true);
    if (tilesetPick.resolved) {
      expect(tilesetPick.kind).toBe("3d-tiles-feature");
      expect(tilesetPick.sourceId).toBe("city-3dtiles");
      expect(tilesetPick.featureId).toBe(501);
    }

    const pointCloudPick = normalizeCesiumPick({
      pointId: 999,
      getPropertyIds: () => ["Classification", "Intensity"],
      getProperty: (k: string) => (k === "Classification" ? 6 : 210),
    });
    expect(pointCloudPick.resolved && pointCloudPick.kind).toBe("point-cloud");

    const modelPick = normalizeCesiumPick(
      { id: "crane-1", node: { name: "Boom" }, mesh: { name: "Steel" } },
      { defaultSourceId: "site-models" },
    );
    expect(modelPick.resolved && modelPick.kind).toBe("model");

    const emptyPick = pickNormalizedSceneFeature(
      {
        primitives: { add: (p: unknown) => p, remove: () => true, contains: () => false },
        pick: () => undefined,
      },
      { x: 10, y: 20 },
    );
    expect(emptyPick.resolved).toBe(false);
    if (!emptyPick.resolved) {
      expect(emptyPick.diagnostic.code).toBe("pick-empty");
    }
  });

  it("attaches explicit provenance on measurements and elevation profiles and supports height mode", async () => {
    const heightMeasure = measureScenePositions(
      [
        { longitude: -122.4, latitude: 37.78, height: 15 },
        { longitude: -122.4, latitude: 37.78, height: 142.5 },
      ],
      "height",
    );
    expect(heightMeasure.heightDeltaMeters).toBeCloseTo(127.5, 4);
    expect(formatMeasurementLabel(heightMeasure)).toBe("+127.5 m");
    expect(heightMeasure.provenance?.degraded).toBe(false);

    const degradedMeasure = measureScenePositions(
      [
        { longitude: -122.4, latitude: 37.78 },
        { longitude: -122.41, latitude: 37.79 },
      ],
      "distance",
    );
    expect(degradedMeasure.provenance?.degraded).toBe(true);
    expect(degradedMeasure.provenance?.degradationReasons.length).toBeGreaterThan(0);

    const profile = await requestElevationProfile(
      async () =>
        ({
          datasetId: "dem",
          layerId: 0,
          sampleCount: 2,
          lineLengthMeters: 50,
          lineSrid: 4326,
          isAllNoData: false,
          samples: [
            { distanceMeters: 0, elevation: 12, noData: false },
            { distanceMeters: 50, elevation: null, noData: true },
          ],
        }) as unknown as never,
      {
        datasetId: "dem",
        polyline: [
          { longitude: -122.4, latitude: 37.78 },
          { longitude: -122.401, latitude: 37.781 },
        ],
      },
    );
    expect(profile.provenance?.degraded).toBe(true);
    expect(profile.provenance?.degradationReasons).toContain("terrain-partial-nodata");
  });

  it("round-trips bookmarks including projection, verticalDatum, camera, and timeline state through SceneStore", () => {
    const store = createSceneStore({
      camera: { longitude: -122.41, latitude: 37.78, height: 1200, heading: 45, pitch: -30, roll: 0 },
      timeline: { currentTime: "2026-11-21T12:00:00Z", playing: false, speed: 1 },
    });

    const captured = captureSceneBookmark(store.state, {
      id: "bm-noon",
      label: "Noon Harbor",
      projection: "EPSG:4326",
      verticalDatum: "EGM2008",
    });
    const roundTripped = parseSceneBookmark(serializeSceneBookmark(captured));
    expect(roundTripped).toEqual(captured);

    store.dispatch({ kind: "set-camera", camera: { longitude: 0, latitude: 0, height: 5000 } });
    store.dispatch({ kind: "set-timeline", timeline: { currentTime: "2026-01-01T00:00:00Z", playing: true } });
    store.dispatch({ kind: "apply-bookmark", bookmark: roundTripped });

    expect(store.state.camera).toEqual(captured.camera);
    expect(store.state.timeline.currentTime).toBe("2026-11-21T12:00:00Z");
    expect(store.state.timeline.playing).toBe(false);
  });
});

describe("scene-aware 3D edit proposals, fail-closed vertical validation, receipts, and realtime reconciliation", () => {
  const baseCaps = {
    canEdit: true,
    supportsZ: true,
    supportedGeometryKinds: ["point", "model-placement"] as const,
    supportedVerticalDatums: ["WGS84", "EGM2008"],
    supportedAltitudeReferences: ["ellipsoidal", "relative-to-ground", "clamped-to-ground"] as const,
    sourceVersion: "v12",
    authorizationScope: ["scene:edit", "source:towers:write"],
  };

  it("fails closed on Z-flattening, missing edit capability, or unsupported vertical references", () => {
    const flattened = createSceneEditProposal({
      proposalId: "prop-flat",
      sourceId: "towers",
      featureId: 7,
      operation: "update",
      geometryKind: "point",
      after: { coordinates: [-122.4, 37.78, 88.5] },
      verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "ellipsoidal" },
      capabilities: { ...baseCaps, supportsZ: false },
    });
    expect(flattened.status).toBe("rejected");
    expect(flattened.diagnostics.some((d) => d.code === "scene-edit-z-flattening-forbidden")).toBe(true);

    const priorPlacement = { coordinates: [-122.4, 37.78, 88.5] as const };
    const base = {
      proposalId: "prop-update",
      sourceId: "towers",
      featureId: 7,
      operation: "update",
      geometryKind: "point",
      before: priorPlacement,
      verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "ellipsoidal" },
      capabilities: baseCaps,
    } as const;
    for (const coordinates of [
      [-122.4, 37.78],
      [Number.NaN, 37.78, 88.5],
      [-122.4, 37.78, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(createSceneEditProposal({ ...base, after: { coordinates } }).status).toBe("rejected");
    }

    const unsupportedDatum = createSceneEditProposal({
      proposalId: "prop-datum",
      sourceId: "towers",
      featureId: 7,
      operation: "update",
      geometryKind: "polygon",
      after: { coordinates: [-122.4, 37.78, 10] },
      verticalContext: { crs: "EPSG:4326", verticalDatum: "NAVD88", altitudeReference: "absolute-orthometric" },
      capabilities: { ...baseCaps, canEdit: false },
    });
    expect(unsupportedDatum.status).toBe("rejected");
    const codes = unsupportedDatum.diagnostics.map((d) => d.code);
    expect(codes).toContain("scene-edit-capability-denied");
    expect(codes).toContain("scene-edit-geometry-unsupported");
    expect(codes).toContain("scene-edit-vertical-reference-unsupported");
  });

  it("requires explicit review for lossy clamped-to-ground Z edits and emits durable receipt + store reconciliation intents", async () => {
    const proposal = createSceneEditProposal({
      proposalId: "prop-clamp",
      sourceId: "towers",
      featureId: 42,
      operation: "update",
      geometryKind: "model-placement",
      after: {
        coordinates: [-122.4, 37.78, 12.5],
        orientation: [0, 0, 90],
        scale: 1.1,
        attributes: { status: "active" },
      },
      verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "clamped-to-ground" },
      capabilities: baseCaps,
    });
    expect(proposal.status).toBe("review-required");
    await expect(
      applySceneEditProposal({
        proposal,
        execute: async () => ({ receiptId: "r-1" }),
      }),
    ).rejects.toThrow(/review-required/);

    const approved = approveSceneEditProposal(proposal);
    const receipt = await applySceneEditProposal({
      proposal: approved,
      execute: async () => ({ receiptId: "rcpt-42", sourceVersion: "v13" }),
      now: () => "2026-11-21T16:00:00Z",
    });
    expect(receipt.receiptId).toBe("rcpt-42");
    expect(receipt.sourceVersion).toBe("v13");
    expect(receipt.verticalContext.verticalDatum).toBe("WGS84");
    expect(receipt.authorizationScope).toEqual(["scene:edit", "source:towers:write"]);

    const store = createSceneStore();
    for (const intent of receipt.reconciliationIntents) {
      store.dispatch(intent);
    }
    expect(store.state.selection).toEqual([{ sourceId: "towers", id: 42 }]);
    expect(store.state.detail.attributes).toEqual({ status: "active" });
  });

  it("reconciles realtime remote deletions and version conflicts against active proposals", () => {
    const ready = createSceneEditProposal({
      proposalId: "prop-live",
      sourceId: "towers",
      featureId: 99,
      operation: "update",
      geometryKind: "point",
      after: { coordinates: [-122.4, 37.78, 50] },
      verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "ellipsoidal" },
      capabilities: baseCaps,
    });

    const versionConflict = reconcileSceneEditWithRealtime(ready, {
      kind: "updated",
      sourceId: "towers",
      featureId: 99,
      sourceVersion: "v13",
    });
    expect(versionConflict.proposal.status).toBe("review-required");
    expect(versionConflict.clearSelection).toBe(false);

    const deleted = reconcileSceneEditWithRealtime(ready, {
      kind: "deleted",
      sourceId: "towers",
      featureId: 99,
    });
    expect(deleted.proposal.status).toBe("invalidated");
    for (const terminal of [deleted.proposal, { ...ready, status: "rejected" } as const]) {
      const updated = reconcileSceneEditWithRealtime(terminal, {
        kind: "updated",
        sourceId: "towers",
        featureId: 99,
        sourceVersion: "v13",
      });
      expect(updated.proposal).toBe(terminal);
      expect(() => approveSceneEditProposal(updated.proposal)).toThrow(/Cannot approve/);
    }
    expect(deleted.clearSelection).toBe(true);
    expect(deleted.reconciliationIntents.some((i) => i.kind === "clear-selection")).toBe(true);
  });
});
