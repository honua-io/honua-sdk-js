import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  type SceneRuntimePrimitive,
  applyMapLibreScenePrimitives,
  createSceneWorkspace,
  diagnoseScenePrimitives,
  emptySceneWorkspaceState,
  sceneWorkspaceIntentFromAdapterEvent,
  selectSceneDiagnosticsByStatus,
  selectSceneEvidenceForFeature,
  selectScenePrimitivesByKind,
  selectSceneVisibleLayers,
  toMapLibreExtrusionLayer,
  toMapLibreTerrainPatch,
} from "../src/scene-workspace/index.js";

describe("scene workspace", () => {
  it("models scene layers, camera, timeline, evidence, realtime, and history without a renderer", () => {
    const workspace = createSceneWorkspace();
    const layerListener = vi.fn();
    const allListener = vi.fn();
    workspace.subscribe("layers", layerListener);
    workspace.subscribe("all", allListener);

    workspace.dispatch({
      kind: "set-scene",
      sceneId: "construction-yard",
      title: "Construction Yard",
      at: "2026-05-05T00:00:00.000Z",
    });
    workspace.dispatch({
      kind: "set-layers",
      layers: [
        { id: "world-model", title: "World model", visible: true, kind: "scene" },
        { id: "incidents", sourceId: "incidents", visible: false, kind: "feature" },
      ],
      at: "2026-05-05T00:00:01.000Z",
    });
    workspace.dispatch({
      kind: "set-camera",
      camera: { longitude: -157.8583, latitude: 21.3069, height: 700, heading: 45, pitch: -35 },
      at: "2026-05-05T00:00:02.000Z",
    });
    workspace.dispatch({
      kind: "set-timeline",
      timeline: {
        currentTime: "2026-05-05T00:05:00.000Z",
        startTime: "2026-05-05T00:00:00.000Z",
        endTime: "2026-05-05T00:10:00.000Z",
        progress: 0.5,
      },
      at: "2026-05-05T00:00:03.000Z",
    });
    workspace.dispatch({
      kind: "add-evidence",
      evidence: {
        id: "ev-1",
        label: "Crane inspection still",
        kind: "image",
        sourceId: "incidents",
        featureId: "INC-7",
      },
      at: "2026-05-05T00:00:04.000Z",
    });
    workspace.dispatch({
      kind: "set-realtime",
      realtime: { status: "stale", cursor: "c7", staleSince: 1_000 },
      at: "2026-05-05T00:00:05.000Z",
    });

    expect(workspace.state.sceneId).toBe("construction-yard");
    expect(selectSceneVisibleLayers(workspace.state).map((layer) => layer.id)).toEqual(["world-model"]);
    expect(workspace.state.camera?.height).toBe(700);
    expect(workspace.state.timeline.progress).toBe(0.5);
    expect(selectSceneEvidenceForFeature(workspace.state, "INC-7")).toHaveLength(1);
    expect(workspace.state.realtime.status).toBe("stale");
    expect(workspace.state.history.map((entry) => entry.intentKind)).toEqual([
      "set-scene",
      "set-layers",
      "set-camera",
      "set-timeline",
      "add-evidence",
      "set-realtime",
    ]);
    expect(layerListener).toHaveBeenCalledTimes(1);
    expect(allListener).toHaveBeenCalledTimes(6);
  });

  it("keeps scene, map, table, and detail selection targets source-qualified", () => {
    const workspace = createSceneWorkspace();
    const sceneTarget = sourceFeatureSelectionTarget("scene-assets", "asset-101");
    const mapTarget = sourceFeatureSelectionTarget("work-orders", "asset-101");

    workspace.dispatch({
      kind: "set-selection",
      selection: [sceneTarget, mapTarget, sceneTarget],
      source: "scene",
    });

    expect(workspace.state.selection).toEqual([sceneTarget, mapTarget]);
  });

  it("keeps primitive, filter, selection, and detail state synchronized for scene-linked views", () => {
    const workspace = createSceneWorkspace();
    const selected = sourceFeatureSelectionTarget("scene-assets", "asset-101");

    workspace.dispatch({
      kind: "set-primitives",
      primitives: [
        {
          kind: "elevation-source",
          id: "oahu-dem",
          sourceId: "oahu-dem-source",
          protocol: "terrain-rgb",
          tiles: ["/terrain/{z}/{y}/{x}.png"],
          encoding: "mapbox",
          tileSize: 512,
          exaggeration: 1.35,
          cache: { status: "ready", scope: "tiles", ttlMs: 86_400_000 },
        },
        {
          kind: "extrusion",
          id: "asset-extrusions",
          sourceId: "scene-assets",
          height: ["get", "extrusion_height_m"],
        },
      ],
    });
    workspace.dispatch({
      kind: "set-filter",
      id: "asset-status",
      clause: { field: "status", operator: "=", value: "active", appliesTo: ["scene-assets"] },
      source: "map",
    });
    workspace.dispatch({ kind: "set-selection", selection: [selected], source: "table" });
    workspace.dispatch({
      kind: "set-detail",
      detail: {
        target: selected,
        sourceId: "scene-assets",
        featureId: "asset-101",
        title: "Asset 101",
        status: "ready",
        attributes: { status: "active" },
      },
      source: "detail",
    });

    expect(selectScenePrimitivesByKind(workspace.state, "elevation-source")[0]?.sourceId).toBe("oahu-dem-source");
    expect(workspace.state.filters["asset-status"]?.value).toBe("active");
    expect(workspace.state.selection).toEqual([selected]);
    expect(workspace.state.detail).toMatchObject({ sourceId: "scene-assets", featureId: "asset-101" });

    const snapshot = workspace.snapshot();
    (snapshot.state.detail.attributes as { status: string }).status = "mutated";
    expect(workspace.state.detail.attributes).toEqual({ status: "active" });
  });

  it("rejects credential-bearing and malformed imagery before workspace serialization", () => {
    const workspace = createSceneWorkspace();
    const unsafePrimitives: SceneRuntimePrimitive[] = [
      {
        kind: "imagery-layer",
        id: "signed-imagery",
        sourceId: "signed-imagery",
        protocol: "url-template",
        url: "https://tiles.example.test/{z}/{x}/{y}.png?X-Amz-Signature=secret",
      },
      {
        kind: "imagery-layer",
        id: "parameter-secret",
        sourceId: "parameter-secret",
        protocol: "wms",
        url: "https://maps.example.test/wms",
        layer: "world",
        parameters: { token: "secret" },
      },
      {
        kind: "imagery-layer",
        id: "access-key-url",
        sourceId: "access-key-url",
        protocol: "url-template",
        url: "https://tiles.example.test/{z}/{x}/{y}.png?aws_access_key_id=secret",
      },
      {
        kind: "imagery-layer",
        id: "access-key-parameter",
        sourceId: "access-key-parameter",
        protocol: "wms",
        url: "https://maps.example.test/wms",
        layer: "world",
        parameters: { access_key: "secret" },
      },
      {
        kind: "imagery-layer",
        id: "fragment-secret",
        sourceId: "fragment-secret",
        protocol: "url-template",
        url: "https://tiles.example.test/{z}/{x}/{y}.png#access_token=secret",
      },
      {
        kind: "imagery-layer",
        id: "encoded-fragment-secret",
        sourceId: "encoded-fragment-secret",
        protocol: "url-template",
        url: "https://tiles.example.test/{z}/{x}/{y}.png#access_token%3Dsecret",
      },
      {
        kind: "imagery-layer",
        id: "malformed-imagery",
        sourceId: "malformed-imagery",
        protocol: "single-tile",
        url: "http://[",
      },
      {
        kind: "imagery-layer",
        id: "malformed-parameters",
        sourceId: "malformed-parameters",
        protocol: "wms",
        url: "https://maps.example.test/wms",
        layer: "world",
        parameters: [{ token: "secret" }],
      } as unknown as SceneRuntimePrimitive,
      {
        kind: "imagery-layer",
        id: "unsafe-subdomain",
        sourceId: "unsafe-subdomain",
        protocol: "url-template",
        url: "https://{s}.tiles.example.test/{z}/{x}/{y}.png",
        subdomains: ["evil.test/path"],
      },
    ];

    for (const primitive of unsafePrimitives) {
      expect(() => workspace.dispatch({ kind: "set-primitives", primitives: [primitive] })).toThrow(
        /credential-free|invalid provider URL|invalid service parameters|invalid subdomains/,
      );
      expect(workspace.state.primitives).toEqual({});
    }
  });

  it.each([
    "access-key",
    "access_token",
    "api-key",
    "x-api-key",
    "credentials",
    "subscription-key",
    "Ocp-Apim-Subscription-Key",
    "refresh-token",
    "key-pair-id",
    "x-goog-signature",
    "sas",
    "shared-access-signature",
    "aws_secret_access_key",
    "secret_access_key",
    "secret_key",
    "secret-key",
    "client_secret_key",
    "private_key",
    "client_private_key",
    "signing_key",
    "client_signing_key",
    "encryption_key",
    "client_encryption_key",
    "passphrase",
    "client_passphrase",
    "tenant_api_key",
    "vendor_subscription_key",
    "oauth_token",
    "database_password",
    "client_credential",
  ])("rejects credential-shaped imagery key alias %s in URLs and parameters", (key) => {
    const workspace = createSceneWorkspace();
    const encodedKey = encodeURIComponent(key);
    expect(() =>
      workspace.dispatch({
        kind: "set-primitives",
        primitives: [
          {
            kind: "imagery-layer",
            id: "credential-url",
            sourceId: "credential-url",
            protocol: "url-template",
            url: `https://tiles.example.test/{z}/{x}/{y}.png?${encodedKey}=secret`,
          },
        ],
      }),
    ).toThrow(/credential-free/);
    expect(() =>
      workspace.dispatch({
        kind: "set-primitives",
        primitives: [
          {
            kind: "imagery-layer",
            id: "credential-parameter",
            sourceId: "credential-parameter",
            protocol: "wms",
            url: "https://maps.example.test/wms",
            layer: "world",
            parameters: { [key]: "secret" },
          },
        ],
      }),
    ).toThrow(/credential-free/);
    expect(workspace.state.primitives).toEqual({});
  });

  it.each([
    "language",
    "time",
    "elevation",
    "layers",
    "format",
    "style",
    "cache",
    "sr",
    "se",
    "sp",
    "spr",
    "sv",
    "tokenizer",
    "credentialType",
    "passwordPolicy",
    "secretary",
    "secretKeyframe",
    "privateKeyboard",
    "signingKeyboard",
    "encryptionKeyboard",
    "passphrasePolicy",
    "apiKeyFormat",
    "subscriptionKeyboard",
    "monkey",
    "keyframe",
    "signatureAlgorithm",
  ])("preserves ordinary imagery service parameter %s", (key) => {
    const workspace = createSceneWorkspace();
    expect(() =>
      workspace.dispatch({
        kind: "set-primitives",
        primitives: [
          {
            kind: "imagery-layer",
            id: "public-imagery",
            sourceId: "public-imagery",
            protocol: "wms",
            url: "https://maps.example.test/wms",
            layer: "world",
            parameters: { [key]: "public" },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("serializes primitive diagnostics and MapLibre terrain/extrusion patches without renderer imports", () => {
    const primitives: SceneRuntimePrimitive[] = [
      {
        kind: "elevation-source" as const,
        id: "oahu-dem",
        sourceId: "oahu-dem-source",
        protocol: "terrain-rgb" as const,
        tiles: ["/terrain/{z}/{y}/{x}.png"],
        encoding: "mapbox" as const,
        tileSize: 512,
        exaggeration: 1.35,
      },
      {
        kind: "model-layer" as const,
        id: "field-command-model",
        uri: "/models/command.glb",
        format: "glb" as const,
      },
      {
        kind: "extrusion" as const,
        id: "asset-extrusions",
        sourceId: "scene-assets",
        height: ["get", "extrusion_height_m"],
        color: "#4d8a87",
        filters: {
          active: { field: "status", operator: "=", value: "active", appliesTo: ["scene-assets"] },
          ignored: { field: "tenant", operator: "=", value: "other", appliesTo: ["other-source"] },
        },
      },
    ];

    const diagnostics = diagnoseScenePrimitives(primitives, {
      renderer: "maplibre",
      camera: true,
      ground: true,
      terrain: { protocols: ["terrain-rgb"], supportsExaggeration: true },
      extrusion: true,
      modelLayer: { formats: [] },
      sceneLayerMetadata: true,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(["supported", "unsupported", "supported"]);
    expect(diagnostics[1]).toMatchObject({
      primitiveId: "field-command-model",
      fallback: "Preserve model metadata and route to a 3D renderer adapter.",
    });

    const terrainPrimitive = primitives.find((primitive) => primitive.kind === "elevation-source");
    if (!terrainPrimitive) throw new Error("missing terrain primitive");
    const terrainPatch = toMapLibreTerrainPatch(terrainPrimitive);
    expect(terrainPatch).toMatchObject({
      sourceId: "oahu-dem-source",
      source: { type: "raster-dem", tileSize: 512 },
      terrain: { source: "oahu-dem-source", exaggeration: 1.35 },
    });

    const extrusionPrimitive = primitives.find((primitive) => primitive.kind === "extrusion");
    if (!extrusionPrimitive) throw new Error("missing extrusion primitive");
    expect(toMapLibreExtrusionLayer(extrusionPrimitive)).toMatchObject({
      id: "asset-extrusions",
      type: "fill-extrusion",
      source: "scene-assets",
      paint: { "fill-extrusion-height": ["get", "extrusion_height_m"] },
      filter: ["all", ["==", "status", "active"]],
    });
  });

  it("diagnoses non-renderable terrain-rgb sources and invalid terrain ranges", () => {
    const diagnostics = diagnoseScenePrimitives(
      [
        {
          kind: "elevation-source",
          id: "bad-terrain",
          sourceId: "terrain-source",
          protocol: "terrain-rgb",
          tiles: [],
          tileSize: 0,
          minzoom: 15,
          maxzoom: 8,
          exaggeration: Number.POSITIVE_INFINITY,
        },
      ],
      {
        renderer: "maplibre",
        terrain: { protocols: ["terrain-rgb"], supportsExaggeration: true },
      },
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "scene-primitive-terrain-source-missing-url",
      "scene-primitive-terrain-range-invalid",
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.status === "unsupported")).toBe(true);
    expect(diagnostics[1].context).toMatchObject({
      tileSize: 0,
      zoomRange: [15, 8],
      exaggeration: Number.POSITIVE_INFINITY,
    });
  });

  it("applies supported MapLibre scene primitives and reports degraded runtime state", () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const sources = new Set<string>();
    const layers = new Set<string>();
    const target = {
      getSource(id: string) {
        return sources.has(id) ? {} : undefined;
      },
      addSource(id: string, source: unknown) {
        calls.push({ method: "addSource", args: [id, source] });
        sources.add(id);
      },
      getLayer(id: string) {
        return layers.has(id) ? {} : undefined;
      },
      addLayer(layer: { id: string }) {
        calls.push({ method: "addLayer", args: [layer] });
        layers.add(layer.id);
      },
      setTerrain(options: unknown) {
        calls.push({ method: "setTerrain", args: [options] });
      },
    };

    const result = applyMapLibreScenePrimitives(target, [
      {
        kind: "elevation-source",
        id: "terrain",
        sourceId: "terrain-source",
        protocol: "terrain-rgb",
        tiles: ["/terrain/{z}/{y}/{x}.png"],
      },
      {
        kind: "scene-layer-metadata",
        id: "buildings-scene",
        layer: { id: "buildings", visible: true, kind: "scene" },
        serviceType: "SceneServer",
      },
    ]);

    expect(calls.map((call) => call.method)).toEqual(["addSource", "setTerrain"]);
    expect(result.status).toBe("degraded");

    const workspace = createSceneWorkspace();
    workspace.dispatch(
      sceneWorkspaceIntentFromAdapterEvent({ type: "primitive-diagnostics", diagnostics: result.diagnostics }),
    );
    expect(selectSceneDiagnosticsByStatus(workspace.state, "degraded")).toHaveLength(1);
  });

  it("translates renderer adapter events into workspace intents", () => {
    const workspace = createSceneWorkspace();
    const intent = sceneWorkspaceIntentFromAdapterEvent(
      {
        type: "selection-change",
        selection: [sourceFeatureSelectionTarget("scene-assets", "asset-9")],
      },
      "map",
    );

    workspace.dispatch(intent);

    expect(intent).toMatchObject({ kind: "set-selection", source: "map" });
    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-9")]);
  });

  it("snapshots and restores serializable scene state", () => {
    const workspace = createSceneWorkspace({
      sceneId: "initial",
      layers: { initial: { id: "initial", visible: true } },
    });

    const snapshot = workspace.snapshot();
    workspace.dispatch({ kind: "set-scene", sceneId: "changed" });
    workspace.dispatch({ kind: "set-layer-visibility", layerId: "initial", visible: false });

    workspace.restore(snapshot);

    expect(workspace.state.sceneId).toBe("initial");
    expect(workspace.state.layers.initial?.visible).toBe(true);
    expect(snapshot.state).not.toBe(workspace.state);
  });

  it("detaches initial state and snapshots from caller-owned nested objects", () => {
    const selected = sourceFeatureSelectionTarget("scene-assets", "asset-1");
    const initial = {
      layers: { assets: { id: "assets", visible: true } },
      selection: [selected],
      evidence: {
        ev1: {
          id: "ev1",
          label: "Inspection packet",
          kind: "document" as const,
          featureId: "asset-1",
          metadata: { nested: { status: "original" } },
        },
      },
    };
    const workspace = createSceneWorkspace(initial);

    initial.layers.assets.visible = false;
    (selected as { id: string }).id = "mutated";
    (initial.evidence.ev1.metadata.nested as { status: string }).status = "mutated";

    expect(workspace.state.layers.assets?.visible).toBe(true);
    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-1")]);
    expect(workspace.state.evidence.ev1?.metadata).toEqual({ nested: { status: "original" } });

    const snapshot = workspace.snapshot();
    (snapshot.state.evidence.ev1?.metadata?.nested as { status: string }).status = "snapshot-mutated";
    (snapshot.state.selection[0] as { id: string }).id = "snapshot-mutated";

    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-1")]);
    expect(workspace.state.evidence.ev1?.metadata).toEqual({ nested: { status: "original" } });
  });

  it("timestamps history with dispatch time when callers do not supply at", () => {
    const workspace = createSceneWorkspace();
    const before = Date.now();

    workspace.dispatch({ kind: "set-scene", sceneId: "live-scene" });

    const timestamp = Date.parse(workspace.state.history[0]?.at ?? "");
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("disposes subscriptions and rejects later dispatches", () => {
    const workspace = createSceneWorkspace();
    const listener = vi.fn();
    workspace.subscribe("scene", listener);
    workspace.dispose();

    expect(() => workspace.dispatch({ kind: "set-scene", sceneId: "late" })).toThrow(/disposed/);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not introduce a Cesium runtime dependency in the core scene workspace", () => {
    const sceneWorkspaceRoot = path.resolve(process.cwd(), "src", "scene-workspace");
    const files = fs.readdirSync(sceneWorkspaceRoot).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => fs.readFileSync(path.join(sceneWorkspaceRoot, file), "utf8")).join("\n");

    expect(source).not.toMatch(/from "cesium"|from 'cesium'|maplibre-gl/);
    expect(emptySceneWorkspaceState().realtime.status).toBe("idle");
  });
});
