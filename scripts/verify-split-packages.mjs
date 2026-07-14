#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGES_ROOT = path.join(PROJECT_ROOT, "dist", "packages");
const EXPECTED_PUBLISHED_NODE_ENGINE = ">=20.0.0";
const ROOT_PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const EXPECTED_LICENSE = ROOT_PACKAGE_JSON.license;

const packageDirs = {
  "@honua/sdk": path.join(PACKAGES_ROOT, "honua-sdk"),
  "@honua/sdk-esri-compat": path.join(PACKAGES_ROOT, "honua-sdk-esri-compat"),
  "@honua/honua-migrate": path.join(PACKAGES_ROOT, "honua-migrate"),
  "@honua/react": path.join(PACKAGES_ROOT, "honua-react"),
  "@honua/geometry": path.join(PACKAGES_ROOT, "honua-geometry"),
  "@honua/app-platform": path.join(PACKAGES_ROOT, "honua-app-platform"),
};

for (const [name, directory] of Object.entries(packageDirs)) {
  if (!fs.existsSync(directory)) {
    process.stderr.write(`Missing split package output for ${name}: ${directory}\n`);
    process.stderr.write('Run "npm run build:split-packages" first.\n');
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  if (packageJson?.engines?.node !== EXPECTED_PUBLISHED_NODE_ENGINE) {
    process.stderr.write(
      `Unexpected published Node engine for ${name}: ${packageJson?.engines?.node ?? "<missing>"}\n`,
    );
    process.stderr.write(
      `Expected split packages to keep the SDK runtime floor at ${EXPECTED_PUBLISHED_NODE_ENGINE}.\n`,
    );
    process.exit(1);
  }

  if (packageJson?.license !== EXPECTED_LICENSE) {
    process.stderr.write(
      `Missing or unexpected license for ${name}: ${packageJson?.license ?? "<missing>"} (expected ${EXPECTED_LICENSE}).\n`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(path.join(directory, "LICENSE"))) {
    process.stderr.write(`Missing LICENSE file in split package ${name}: ${directory}\n`);
    process.exit(1);
  }
}

const generatedProjJsonValidator = path.join(
  packageDirs["@honua/sdk"],
  "contract",
  "generated",
  "projjson-v0.7-crs-validator.js",
);
const generatedProjJsonContents = fs.readFileSync(generatedProjJsonValidator, "utf8");
for (const noticeFragment of [
  "Copyright (c) Even Rouault and PROJ contributors, 2019-2023",
  "Copyright (c) 2015-2021 Evgeny Poberezkin",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
]) {
  if (!generatedProjJsonContents.includes(noticeFragment)) {
    process.stderr.write(`Split @honua/sdk PROJJSON validator is missing required license text: ${noticeFragment}\n`);
    process.exit(1);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-split-verify-"));

try {
  const packageJson = {
    name: "honua-split-verify",
    private: true,
    type: "module",
    dependencies: {
      "@honua/sdk": `file:${packageDirs["@honua/sdk"]}`,
      "@honua/sdk-esri-compat": `file:${packageDirs["@honua/sdk-esri-compat"]}`,
      "@honua/honua-migrate": `file:${packageDirs["@honua/honua-migrate"]}`,
      "@honua/react": `file:${packageDirs["@honua/react"]}`,
      react: ROOT_PACKAGE_JSON.devDependencies.react,
      "react-dom": ROOT_PACKAGE_JSON.devDependencies["react-dom"],
      "@honua/geometry": `file:${packageDirs["@honua/geometry"]}`,
      "@honua/app-platform": `file:${packageDirs["@honua/app-platform"]}`,
    },
  };
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );

  const smokeScript = `
import {
  HonuaClient,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaImageService,
  HonuaMapLayer,
  connect,
} from "@honua/sdk";
import { HonuaGeocodingClient, nominatimGeocodingProvider } from "@honua/sdk/geocoding";
import { osrmRoutingProvider, valhallaRoutingProvider } from "@honua/sdk/routing";
import { oauth2, clientCredentials, apiKeyAuth, InMemoryCredentialStore } from "@honua/sdk/auth";
import { HONUA_PLUGIN_MANIFEST_VERSION, validateHonuaPluginManifest } from "@honua/sdk/plugin";
import { createSourceSchemaV2 } from "@honua/sdk/source-schema";
import { evaluateCapabilityProfile } from "@honua/sdk/source-capabilities";
import {
  HONUA_CONTROL_PLANE_BASE_PATH,
  createHonuaControlPlane,
} from "@honua/app-platform/control-plane";
import {
  createFixtureSavedMapCollaborationTransport,
  createHonuaSavedMapCollaboration,
} from "@honua/app-platform/collaboration";
import {
  parseEmbedTokenFromFragment,
  toDcatDataset,
} from "@honua/app-platform/share";
import {
  HONUA_OPERATE_BASE_PATH,
  HonuaOperateClient,
  createHonuaOperate,
} from "@honua/app-platform/operate";
import {
  CAPABILITIES,
  PROTOCOLS,
  createDataset,
  geoServicesGPServiceSource,
  geoServicesGeometryServiceSource,
  geoServicesImageSource,
} from "@honua/sdk/contract";
import {
  HONUA_AGENT_TOOL_NAMES,
  explainHonuaCapabilityGap,
} from "@honua/sdk/agent-tools";
import {
  AGENT_CONSUMPTION_KIND,
  AGENT_EXECUTION_AUDIT_KIND,
  AGENT_SAFETY_HARD_LIMITS,
  AGENT_SAFETY_VERSION,
  dryRunAgentPlan,
  executeAgentPlanStep,
} from "@honua/sdk/agent-safety";
import {
  NL_MAP_PLAN_KIND,
  createNlMapControl,
  toNlMapControlMcpToolDefinitions,
} from "@honua/sdk/nl-map-control";
import {
  createHonuaApp,
  normalizeHonuaAppOptions,
} from "@honua/app-platform/app";
import {
  EMPTY_STATE,
  LINKED_VIEW_PRESETS,
  createExplorationContext,
  selectLinkedViewQueryProjection,
} from "@honua/sdk/exploration";
import {
  createFilterRegistry,
  projectFilterRegistryToQuery,
} from "@honua/sdk/filter-registry";
import {
  bindChartToExploration,
  bindQueryProjectionToExploration,
} from "@honua/sdk/interactions";
import {
  HONUA_CONTROLLER_SNAPSHOT_VERSION,
  createHonuaController,
} from "@honua/app-platform/app-controller";
import {
  createHonuaAppWorkspace,
  selectHonuaAppWorkspaceMetadataCacheModel,
} from "@honua/app-platform/app-workspace";
import {
  createSceneWorkspace,
  sceneWorkspaceIntentFromAdapterEvent,
} from "@honua/app-platform/scene-workspace";
import { HonuaMap, mountSourceToMapLibre } from "@honua/sdk/map";
import { HONUA_OFFLINE_REGION_VERSION, planOfflineRegionAdmission } from "@honua/sdk/offline";
import { createColumnarBatch, explainQuery, inspectColumnarBatch } from "@honua/sdk/query-planner";
import { DECK_GL_ADAPTER_CONTRACT_VERSION } from "@honua/sdk/deckgl";
import { validateHonuaStyle } from "@honua/sdk/style";
import { loadMapPackage, validateRuntimeStyleSpec } from "@honua/sdk/runtime";
import {
  REALTIME_DURABLE_CHECKPOINT_VERSION,
  createResumableRealtimeSubscription,
} from "@honua/sdk/realtime";
import {
  HonuaLayerListElement,
  HonuaLegendElement as HonuaWebComponentLegendElement,
  HonuaMeasurementElement,
  HonuaSearchElement,
  createHonuaWebComponentController,
  defineHonuaWebComponents,
} from "@honua/app-platform/web-components";
import {
  HonuaBasemapStyleBinding,
  HonuaBasemapSwitcherElement,
  HonuaLegendElement,
  defineHonuaControls,
  deriveLegendEntries,
} from "@honua/app-platform/controls";
import { projectBuildSpecToGeneratedAppManifest } from "@honua/app-platform/generated-app";
import { HONUA_QUERY_PACKAGE_FORMAT_V1, toStudioValidationResponse } from "@honua/app-platform/studio";
import { OPERATOR_EXECUTION_OUTPUT_KEY } from "@honua/app-platform/operator";
import { ChatController } from "@honua/app-platform/operator/controllers";
import { OperatorWorkspace } from "@honua/app-platform/operator/workspace";
import { DEFAULT_OPERATOR_TOKENS } from "@honua/app-platform/operator/theming";
import { DEFAULT_MESSAGES } from "@honua/app-platform/operator/i18n";
import {
  AttributionCompat,
  BasemapCompat,
  BasemapToggleCompat,
  BasemapGalleryCompat,
  BasemapLayerListCompat,
  BookmarksCompat,
  CompassCompat,
  CompatEventBus,
  CoordinateConversionCompat,
  ColorCompat,
  createArcGisTokenInterceptor,
  createEsriRequestInterceptors,
  DirectionsCompat,
  esriConfig,
  esriRequest,
  EsriRequestInterceptorRegistry,
  EditorCompat,
  FeatureCompat,
  FeatureFormCompat,
  FeatureSetCompat,
  FeatureTemplatesCompat,
  ExpandCompat,
  FeatureLayerCompat,
  FeatureTableCompat,
  FullscreenCompat,
  getEsriConfigHonuaInterceptors,
  GraphicCompat,
  GraphicsLayerCompat,
  GroupLayerCompat,
  HomeCompat,
  HonuaWidgetHost,
  registerHonuaWidgetKit,
  IdentifyCompat,
  identityManager,
  LayerListCompat,
  LegendCompat,
  LocateCompat,
  MeasurementCompat,
  AreaMeasurement2DCompat,
  DistanceMeasurement2DCompat,
  MapImageLayerCompat,
  MapImageSublayerCompat,
  MapViewCompat,
  MapViewUiCompat,
  PrintCompat,
  PopupCompat,
  OAuthInfoCompat,
  PointCompat,
  PolylineCompat,
  PolygonCompat,
  ExtentCompat,
  SpatialReferenceCompat,
  QueryCompat,
  reactiveUtils,
  resetEsriConfig,
  RouteLayerCompat,
  RouteTaskCompat,
  SearchCompat,
  SketchCompat,
  SimpleLineSymbolCompat,
  SimpleFillSymbolCompat,
  SimpleMarkerSymbolCompat,
  PictureMarkerSymbolCompat,
  TextSymbolCompat,
  LabelClassCompat,
  ClassBreaksRendererCompat,
  SimpleRendererCompat,
  ScaleBarCompat,
  SwipeCompat,
  TableListCompat,
  TrackCompat,
  TimeSliderCompat,
  TileLayerCompat,
  UniqueValueRendererCompat,
  watch,
  when,
  whenOnce,
  ZoomCompat,
} from "@honua/sdk-esri-compat";
import {
  buildJsMigrationReport,
  getJsParityMatrix,
  runEsriCompatCodemod,
  runLayerReconciliation,
  scanArcGisUsage,
  summarizeJsParityMatrix,
} from "@honua/honua-migrate";
import {
  HonuaLayer,
  HonuaMap as HonuaReactMap,
  HonuaPopup,
  HonuaProvider,
  HonuaQueryCache,
  useCapabilities,
  useDataset,
  useHonuaClient,
  useMapRuntime,
  useQuery,
  useRealtime,
} from "@honua/react";
import { area, buffer, project, toWgs84 } from "@honua/geometry";
import { geometryEngineCompat } from "@honua/sdk-esri-compat";

if (typeof HonuaClient !== "function") throw new Error("HonuaClient export missing");
if (typeof connect !== "function") throw new Error("connect export missing from @honua/sdk");
if (typeof HonuaMapLayer !== "function") throw new Error("HonuaMapLayer export missing");
if (typeof HonuaImageService !== "function")
  throw new Error("HonuaImageService export missing from @honua/sdk");
if (typeof HonuaGeometryService !== "function")
  throw new Error("HonuaGeometryService export missing from @honua/sdk");
if (typeof HonuaGeoprocessingService !== "function")
  throw new Error("HonuaGeoprocessingService export missing from @honua/sdk");
if (typeof HonuaGeocodingClient !== "function")
  throw new Error("HonuaGeocodingClient export missing from @honua/sdk/geocoding");
if (typeof nominatimGeocodingProvider !== "function")
  throw new Error("nominatimGeocodingProvider export missing from @honua/sdk/geocoding");
if (typeof osrmRoutingProvider !== "function" || typeof valhallaRoutingProvider !== "function")
  throw new Error("routing provider exports missing from @honua/sdk/routing");
if (typeof oauth2 !== "function" || typeof clientCredentials !== "function" || typeof apiKeyAuth !== "function")
  throw new Error("auth provider exports missing from @honua/sdk/auth");
if (typeof InMemoryCredentialStore !== "function")
  throw new Error("InMemoryCredentialStore export missing from @honua/sdk/auth");
if (HONUA_PLUGIN_MANIFEST_VERSION !== 1 || typeof validateHonuaPluginManifest !== "function")
  throw new Error("plugin certification exports missing from @honua/sdk/plugin");
if (typeof createSourceSchemaV2 !== "function")
  throw new Error("createSourceSchemaV2 export missing from @honua/sdk/source-schema");
const capabilityProfile = evaluateCapabilityProfile(
  [
    {
      id: "query",
      claimed: "supported",
      observed: "supported",
      evidence: [
        { kind: "protocol-default", truth: "supported", reference: "split-package-smoke" },
        {
          kind: "metadata",
          truth: "supported",
          reference: "split-package-smoke",
          observedAt: "2026-07-14T12:00:00Z",
          expiresAt: "2026-07-15T12:00:00Z",
        },
      ],
    },
  ],
  { evaluatedAt: "2026-07-14T12:00:01Z" },
);
if (capabilityProfile.entries[0]?.effective !== "supported")
  throw new Error("evaluateCapabilityProfile export missing from @honua/sdk/source-capabilities");
{
  const staticProvider = apiKeyAuth("k");
  const provided = staticProvider.getCredentials({ reason: "initial", forceRefresh: false });
  if (!provided || provided.apiKey !== "k")
    throw new Error("apiKeyAuth from @honua/sdk/auth did not return the expected credential");
}
if (HONUA_CONTROL_PLANE_BASE_PATH !== "/api/v1/admin")
  throw new Error("HONUA_CONTROL_PLANE_BASE_PATH export missing from @honua/sdk/control-plane");
if (typeof createHonuaControlPlane !== "function")
  throw new Error("createHonuaControlPlane export missing from @honua/sdk/control-plane");
if (typeof createHonuaSavedMapCollaboration !== "function")
  throw new Error("createHonuaSavedMapCollaboration export missing from @honua/sdk/collaboration");
if (typeof createFixtureSavedMapCollaborationTransport !== "function")
  throw new Error("createFixtureSavedMapCollaborationTransport export missing from @honua/sdk/collaboration");
if (typeof parseEmbedTokenFromFragment !== "function" || typeof toDcatDataset !== "function")
  throw new Error("share contract exports missing from @honua/sdk/share");
if (parseEmbedTokenFromFragment("https://app.example/embed?embed_token=leaked").ok)
  throw new Error("share embed-token helper accepted a query-string bearer token");
if (HONUA_OPERATE_BASE_PATH !== "/api/v1/operate")
  throw new Error("HONUA_OPERATE_BASE_PATH export missing from @honua/sdk/operate");
if (typeof createHonuaOperate !== "function" || typeof HonuaOperateClient !== "function")
  throw new Error("operate observability exports missing from @honua/sdk/operate");
if (!Array.isArray(HONUA_AGENT_TOOL_NAMES) || !HONUA_AGENT_TOOL_NAMES.includes("explainCapabilityGap"))
  throw new Error("agent tool exports missing from @honua/sdk/agent-tools");
if (explainHonuaCapabilityGap({ protocol: "wmts", capability: "query" }).supported)
  throw new Error("agent tool capability explanation failed to flag unsupported WMTS query");
if (AGENT_SAFETY_VERSION !== "1.0" || typeof dryRunAgentPlan !== "function")
  throw new Error("agent safety exports missing from @honua/sdk/agent-safety");
if (AGENT_CONSUMPTION_KIND !== "honua.agent-approval-consumption" || AGENT_SAFETY_HARD_LIMITS.steps !== 128)
  throw new Error("agent safety consumption or hard-limit exports missing from @honua/sdk/agent-safety");
if (AGENT_EXECUTION_AUDIT_KIND !== "honua.agent-execution-audit" || typeof executeAgentPlanStep !== "function")
  throw new Error("agent safety execution or audit exports missing from @honua/sdk/agent-safety");
if (NL_MAP_PLAN_KIND !== "honua.nl-map-plan" || typeof createNlMapControl !== "function")
  throw new Error("nl map-control exports missing from @honua/sdk/nl-map-control");
if (toNlMapControlMcpToolDefinitions().length < 12)
  throw new Error("nl map-control MCP tool publication missing from @honua/sdk/nl-map-control");
if (typeof createHonuaApp !== "function")
  throw new Error("createHonuaApp export missing from @honua/sdk/app");
if (typeof normalizeHonuaAppOptions !== "function")
  throw new Error("normalizeHonuaAppOptions export missing from @honua/sdk/app");
if (!Array.isArray(CAPABILITIES) || CAPABILITIES.length === 0)
  throw new Error("CAPABILITIES export missing from @honua/sdk/contract");
if (!Array.isArray(PROTOCOLS) || PROTOCOLS.length === 0)
  throw new Error("PROTOCOLS export missing from @honua/sdk/contract");
if (typeof createDataset !== "function")
  throw new Error("createDataset export missing from @honua/sdk/contract");
if (typeof geoServicesImageSource !== "function")
  throw new Error("geoServicesImageSource export missing from @honua/sdk/contract");
if (typeof geoServicesGeometryServiceSource !== "function")
  throw new Error("geoServicesGeometryServiceSource export missing from @honua/sdk/contract");
if (typeof geoServicesGPServiceSource !== "function")
  throw new Error("geoServicesGPServiceSource export missing from @honua/sdk/contract");
if (typeof EMPTY_STATE !== "object" || EMPTY_STATE === null)
  throw new Error("EMPTY_STATE export missing from @honua/sdk/exploration");
if (typeof LINKED_VIEW_PRESETS !== "object" || LINKED_VIEW_PRESETS === null)
  throw new Error("LINKED_VIEW_PRESETS export missing from @honua/sdk/exploration");
if (typeof createExplorationContext !== "function")
  throw new Error("createExplorationContext export missing from @honua/sdk/exploration");
if (typeof selectLinkedViewQueryProjection !== "function")
  throw new Error("selectLinkedViewQueryProjection export missing from @honua/sdk/exploration");
if (typeof createFilterRegistry !== "function")
  throw new Error("createFilterRegistry export missing from @honua/sdk/filter-registry");
if (typeof projectFilterRegistryToQuery !== "function")
  throw new Error("projectFilterRegistryToQuery export missing from @honua/sdk/filter-registry");
if (typeof bindChartToExploration !== "function")
  throw new Error("bindChartToExploration export missing from @honua/sdk/interactions");
if (typeof bindQueryProjectionToExploration !== "function")
  throw new Error("bindQueryProjectionToExploration export missing from @honua/sdk/interactions");
if (typeof createHonuaController !== "function")
  throw new Error("createHonuaController export missing from @honua/sdk/app-controller");
if (HONUA_CONTROLLER_SNAPSHOT_VERSION !== 1)
  throw new Error("HONUA_CONTROLLER_SNAPSHOT_VERSION export missing from @honua/sdk/app-controller");
if (typeof createHonuaAppWorkspace !== "function")
  throw new Error("createHonuaAppWorkspace export missing from @honua/sdk/app-workspace");
if (typeof selectHonuaAppWorkspaceMetadataCacheModel !== "function")
  throw new Error("selectHonuaAppWorkspaceMetadataCacheModel export missing from @honua/sdk/app-workspace");
if (typeof createSceneWorkspace !== "function")
  throw new Error("createSceneWorkspace export missing from @honua/sdk/scene-workspace");
if (typeof sceneWorkspaceIntentFromAdapterEvent !== "function")
  throw new Error("sceneWorkspaceIntentFromAdapterEvent export missing from @honua/sdk/scene-workspace");
if (typeof HonuaMap !== "function")
  throw new Error("HonuaMap export missing from @honua/sdk/map");
if (typeof validateHonuaStyle !== "function")
  throw new Error("validateHonuaStyle export missing from @honua/sdk/style");
if (typeof loadMapPackage !== "function")
  throw new Error("loadMapPackage export missing from @honua/sdk/runtime");
if (typeof validateRuntimeStyleSpec !== "function")
  throw new Error("validateRuntimeStyleSpec export missing from @honua/sdk/runtime");
if (typeof createResumableRealtimeSubscription !== "function")
  throw new Error("createResumableRealtimeSubscription export missing from @honua/sdk/realtime");
if (REALTIME_DURABLE_CHECKPOINT_VERSION !== 1)
  throw new Error("REALTIME_DURABLE_CHECKPOINT_VERSION export missing from @honua/sdk/realtime");
if (HONUA_OFFLINE_REGION_VERSION !== "1.0" || typeof planOfflineRegionAdmission !== "function")
  throw new Error("offline region exports missing from @honua/sdk/offline");
if (typeof defineHonuaWebComponents !== "function")
  throw new Error("defineHonuaWebComponents export missing from @honua/sdk/web-components");
// Survival-tier widget set (issue #493): the four components plus the
// controller layer-state extensions they bind to.
for (const [name, ctor] of Object.entries({
  HonuaWebComponentLegendElement,
  HonuaLayerListElement,
  HonuaSearchElement,
  HonuaMeasurementElement,
})) {
  if (typeof ctor !== "function")
    throw new Error(name + " export missing from @honua/app-platform/web-components");
}
{
  const widgetController = createHonuaWebComponentController({
    layers: [
      { id: "base", title: "Base", visible: true },
      { id: "overlay", title: "Overlay", visible: true },
    ],
  });
  widgetController.setLayerOpacity("overlay", 0.4);
  widgetController.moveLayer("base");
  const widgetState = widgetController.getState();
  if (widgetState.layers[1]?.id !== "base")
    throw new Error("@honua/app-platform web-component controller moveLayer did not reorder layers");
  if (widgetState.layers[0]?.opacity !== 0.4)
    throw new Error("@honua/app-platform web-component controller setLayerOpacity did not apply");
}
if (typeof defineHonuaControls !== "function")
  throw new Error("defineHonuaControls export missing from @honua/sdk/controls");
if (typeof HonuaBasemapSwitcherElement !== "function")
  throw new Error("HonuaBasemapSwitcherElement export missing from @honua/sdk/controls");
if (typeof HonuaBasemapStyleBinding !== "function")
  throw new Error("HonuaBasemapStyleBinding export missing from @honua/sdk/controls");
{
  const bindingSmoke = new HonuaBasemapStyleBinding();
  bindingSmoke.setBases([
    { id: "light", label: "Light", kind: "vector", sources: {}, layers: [{ id: "light-bg", type: "background" }] },
  ]);
  if (!bindingSmoke.activate("light") || bindingSmoke.activeId !== "light")
    throw new Error("@honua/sdk/controls HonuaBasemapStyleBinding failed to activate a base");
}
if (typeof HonuaLegendElement !== "function")
  throw new Error("HonuaLegendElement export missing from @honua/sdk/controls");
if (typeof deriveLegendEntries !== "function")
  throw new Error("deriveLegendEntries export missing from @honua/sdk/controls");
{
  const legendSmoke = deriveLegendEntries(
    {
      getLayer: () => ({ type: "fill" }),
      getPaintProperty: (_layerId, name) =>
        name === "fill-color" ? ["match", ["get", "district"], "Residential", "#facc15", "#cbd5e1"] : undefined,
    },
    "zoning-districts",
  );
  if (legendSmoke.length !== 2 || legendSmoke[0].label !== "Residential" || legendSmoke[1].label !== "Other")
    throw new Error("@honua/sdk/controls deriveLegendEntries failed to parse a match expression");
}
if (typeof projectBuildSpecToGeneratedAppManifest !== "function")
  throw new Error("projectBuildSpecToGeneratedAppManifest export missing from @honua/app-platform/generated-app");
if (HONUA_QUERY_PACKAGE_FORMAT_V1 !== "honua_query_package.v1")
  throw new Error("HONUA_QUERY_PACKAGE_FORMAT_V1 export missing from @honua/sdk/studio");
if (typeof toStudioValidationResponse !== "function")
  throw new Error("toStudioValidationResponse export missing from @honua/sdk/studio");
if (OPERATOR_EXECUTION_OUTPUT_KEY !== "result")
  throw new Error("OPERATOR_EXECUTION_OUTPUT_KEY export missing from @honua/sdk/operator");
if (typeof ChatController !== "function")
  throw new Error("ChatController export missing from @honua/sdk/operator/controllers");
if (typeof OperatorWorkspace !== "function")
  throw new Error("OperatorWorkspace export missing from @honua/sdk/operator/workspace");
if (typeof DEFAULT_OPERATOR_TOKENS !== "object" || DEFAULT_OPERATOR_TOKENS === null)
  throw new Error("DEFAULT_OPERATOR_TOKENS export missing from @honua/sdk/operator/theming");
if (typeof DEFAULT_MESSAGES !== "object" || DEFAULT_MESSAGES === null)
  throw new Error("DEFAULT_MESSAGES export missing from @honua/sdk/operator/i18n");
if (typeof mountSourceToMapLibre !== "function")
  throw new Error("mountSourceToMapLibre export missing from @honua/sdk/map");
if (typeof explainQuery !== "function")
  throw new Error("explainQuery export missing from @honua/sdk/query-planner");
if (typeof createColumnarBatch !== "function" || typeof inspectColumnarBatch !== "function")
  throw new Error("columnar exports missing from @honua/sdk/query-planner");
{
  const bytes = new ArrayBuffer(8);
  const batch = createColumnarBatch({
    id: "split-smoke",
    sequence: 0,
    rowCount: 1,
    schema: { id: "split-smoke-v1", fields: [{ name: "value", type: { name: "float64" }, nullable: false }] },
    buffers: [{ id: "values", field: "value", role: "values", data: bytes, byteOffset: 0, byteLength: 8 }],
  });
  if (inspectColumnarBatch(batch).copiedBytes !== 0)
    throw new Error("@honua/sdk/query-planner columnar transfer introduced a payload copy");
}
if (DECK_GL_ADAPTER_CONTRACT_VERSION !== "1.0")
  throw new Error("DECK_GL_ADAPTER_CONTRACT_VERSION export missing from @honua/sdk/deckgl");
const styleSpecDiagnostics = await validateRuntimeStyleSpec({
  version: 8,
  sources: {},
  layers: [],
});
if (styleSpecDiagnostics.length !== 0)
  throw new Error("validateRuntimeStyleSpec failed in split package smoke");
if (typeof CompatEventBus !== "function") throw new Error("CompatEventBus export missing");
if (typeof CoordinateConversionCompat !== "function") throw new Error("CoordinateConversionCompat export missing");
if (typeof createEsriRequestInterceptors !== "function") throw new Error("createEsriRequestInterceptors export missing");
if (typeof createArcGisTokenInterceptor !== "function") throw new Error("createArcGisTokenInterceptor export missing");
if (typeof EsriRequestInterceptorRegistry !== "function") throw new Error("EsriRequestInterceptorRegistry export missing");
if (typeof esriConfig !== "object") throw new Error("esriConfig export missing");
if (typeof esriRequest !== "function") throw new Error("esriRequest export missing");
if (typeof getEsriConfigHonuaInterceptors !== "function")
  throw new Error("getEsriConfigHonuaInterceptors export missing");
if (typeof resetEsriConfig !== "function") throw new Error("resetEsriConfig export missing");
if (typeof identityManager !== "object") throw new Error("identityManager export missing");
if (typeof DirectionsCompat !== "function") throw new Error("DirectionsCompat export missing");
if (typeof EditorCompat !== "function") throw new Error("EditorCompat export missing");
if (typeof FeatureCompat !== "function") throw new Error("FeatureCompat export missing");
if (typeof FeatureFormCompat !== "function") throw new Error("FeatureFormCompat export missing");
if (typeof FeatureSetCompat !== "function") throw new Error("FeatureSetCompat export missing");
if (typeof FeatureTemplatesCompat !== "function") throw new Error("FeatureTemplatesCompat export missing");
if (typeof FeatureLayerCompat !== "function") throw new Error("FeatureLayerCompat export missing");
if (typeof FeatureTableCompat !== "function") throw new Error("FeatureTableCompat export missing");
if (typeof HomeCompat !== "function") throw new Error("HomeCompat export missing");
if (typeof BasemapCompat !== "function") throw new Error("BasemapCompat export missing");
if (typeof BasemapToggleCompat !== "function") throw new Error("BasemapToggleCompat export missing");
if (typeof BasemapGalleryCompat !== "function") throw new Error("BasemapGalleryCompat export missing");
if (typeof BasemapLayerListCompat !== "function") throw new Error("BasemapLayerListCompat export missing");
if (typeof BookmarksCompat !== "function") throw new Error("BookmarksCompat export missing");
if (typeof CompassCompat !== "function") throw new Error("CompassCompat export missing");
if (typeof AttributionCompat !== "function") throw new Error("AttributionCompat export missing");
if (typeof LocateCompat !== "function") throw new Error("LocateCompat export missing");
if (typeof MeasurementCompat !== "function") throw new Error("MeasurementCompat export missing");
if (typeof AreaMeasurement2DCompat !== "function") throw new Error("AreaMeasurement2DCompat export missing");
if (typeof DistanceMeasurement2DCompat !== "function") throw new Error("DistanceMeasurement2DCompat export missing");
if (typeof ScaleBarCompat !== "function") throw new Error("ScaleBarCompat export missing");
if (typeof ExpandCompat !== "function") throw new Error("ExpandCompat export missing");
if (typeof FullscreenCompat !== "function") throw new Error("FullscreenCompat export missing");
if (typeof ZoomCompat !== "function") throw new Error("ZoomCompat export missing");
if (typeof GraphicCompat !== "function") throw new Error("GraphicCompat export missing");
if (typeof PointCompat !== "function") throw new Error("PointCompat export missing");
if (typeof PolylineCompat !== "function") throw new Error("PolylineCompat export missing");
if (typeof PolygonCompat !== "function") throw new Error("PolygonCompat export missing");
if (typeof ExtentCompat !== "function") throw new Error("ExtentCompat export missing");
if (typeof SpatialReferenceCompat !== "function")
  throw new Error("SpatialReferenceCompat export missing");
if (typeof ColorCompat !== "function") throw new Error("ColorCompat export missing");
if (typeof GraphicsLayerCompat !== "function") throw new Error("GraphicsLayerCompat export missing");
if (typeof GroupLayerCompat !== "function") throw new Error("GroupLayerCompat export missing");
if (typeof IdentifyCompat !== "function") throw new Error("IdentifyCompat export missing");
if (typeof LayerListCompat !== "function") throw new Error("LayerListCompat export missing");
if (typeof LegendCompat !== "function") throw new Error("LegendCompat export missing");
if (typeof HonuaWidgetHost !== "function") throw new Error("HonuaWidgetHost export missing");
if (typeof registerHonuaWidgetKit !== "function")
  throw new Error("registerHonuaWidgetKit export missing");
{
  // Headless (no DOM): the widget host must resolve to unavailable and its
  // mount must no-op — this is the standalone esri-compat package posture.
  const headlessHost = new HonuaWidgetHost("honua-legend", "some-container-id");
  if (headlessHost.available) throw new Error("HonuaWidgetHost resolved a container without a DOM");
  if ((await headlessHost.mount()) !== undefined)
    throw new Error("HonuaWidgetHost mounted an element without a DOM");
}
if (typeof MapImageLayerCompat !== "function") throw new Error("MapImageLayerCompat export missing");
if (typeof MapImageSublayerCompat !== "function") throw new Error("MapImageSublayerCompat export missing");
if (typeof MapViewCompat !== "function") throw new Error("MapViewCompat export missing");
if (typeof MapViewUiCompat !== "function") throw new Error("MapViewUiCompat export missing");
if (typeof PrintCompat !== "function") throw new Error("PrintCompat export missing");
if (typeof PopupCompat !== "function") throw new Error("PopupCompat export missing");
if (typeof OAuthInfoCompat !== "function") throw new Error("OAuthInfoCompat export missing");
if (typeof QueryCompat !== "function") throw new Error("QueryCompat export missing");
if (typeof reactiveUtils.watch !== "function") throw new Error("reactiveUtils export missing");
if (typeof RouteLayerCompat !== "function") throw new Error("RouteLayerCompat export missing");
if (typeof RouteTaskCompat !== "function") throw new Error("RouteTaskCompat export missing");
if (typeof SearchCompat !== "function") throw new Error("SearchCompat export missing");
if (typeof SketchCompat !== "function") throw new Error("SketchCompat export missing");
if (typeof SimpleLineSymbolCompat !== "function")
  throw new Error("SimpleLineSymbolCompat export missing");
if (typeof SimpleFillSymbolCompat !== "function")
  throw new Error("SimpleFillSymbolCompat export missing");
if (typeof SimpleMarkerSymbolCompat !== "function")
  throw new Error("SimpleMarkerSymbolCompat export missing");
if (typeof PictureMarkerSymbolCompat !== "function")
  throw new Error("PictureMarkerSymbolCompat export missing");
if (typeof TextSymbolCompat !== "function")
  throw new Error("TextSymbolCompat export missing");
if (typeof LabelClassCompat !== "function")
  throw new Error("LabelClassCompat export missing");
if (typeof ClassBreaksRendererCompat !== "function")
  throw new Error("ClassBreaksRendererCompat export missing");
if (typeof SimpleRendererCompat !== "function")
  throw new Error("SimpleRendererCompat export missing");
if (typeof UniqueValueRendererCompat !== "function")
  throw new Error("UniqueValueRendererCompat export missing");
if (typeof TileLayerCompat !== "function") throw new Error("TileLayerCompat export missing");
if (typeof SwipeCompat !== "function") throw new Error("SwipeCompat export missing");
if (typeof TableListCompat !== "function") throw new Error("TableListCompat export missing");
if (typeof TrackCompat !== "function") throw new Error("TrackCompat export missing");
if (typeof TimeSliderCompat !== "function") throw new Error("TimeSliderCompat export missing");
if (typeof watch !== "function") throw new Error("watch export missing");
if (typeof when !== "function") throw new Error("when export missing");
if (typeof whenOnce !== "function") throw new Error("whenOnce export missing");
if (typeof scanArcGisUsage !== "function") throw new Error("scanArcGisUsage export missing");
if (typeof runEsriCompatCodemod !== "function") throw new Error("runEsriCompatCodemod export missing");
if (typeof buildJsMigrationReport !== "function") throw new Error("buildJsMigrationReport export missing");
if (typeof getJsParityMatrix !== "function") throw new Error("getJsParityMatrix export missing");
if (typeof runLayerReconciliation !== "function") throw new Error("runLayerReconciliation export missing");
if (typeof summarizeJsParityMatrix !== "function") throw new Error("summarizeJsParityMatrix export missing");
if (typeof HonuaProvider !== "function") throw new Error("HonuaProvider export missing from @honua/react");
if (typeof useHonuaClient !== "function") throw new Error("useHonuaClient export missing from @honua/react");
if (typeof useDataset !== "function") throw new Error("useDataset export missing from @honua/react");
if (typeof useQuery !== "function") throw new Error("useQuery export missing from @honua/react");
if (typeof useCapabilities !== "function") throw new Error("useCapabilities export missing from @honua/react");
if (typeof useMapRuntime !== "function") throw new Error("useMapRuntime export missing from @honua/react");
if (typeof useRealtime !== "function") throw new Error("useRealtime export missing from @honua/react");
if (typeof HonuaReactMap !== "function") throw new Error("HonuaMap export missing from @honua/react");
if (typeof HonuaLayer !== "function") throw new Error("HonuaLayer export missing from @honua/react");
if (typeof HonuaPopup !== "function") throw new Error("HonuaPopup export missing from @honua/react");
if (typeof HonuaQueryCache !== "function") throw new Error("HonuaQueryCache export missing from @honua/react");

if (typeof buffer !== "function" || typeof area !== "function" || typeof project !== "function")
  throw new Error("geometry op exports missing from @honua/geometry");
{
  const square = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  };
  const buffered = buffer(square, 100, "meters");
  if (!buffered || (buffered.type !== "Polygon" && buffered.type !== "MultiPolygon"))
    throw new Error("@honua/geometry buffer did not return a polygon");
  if (!(area(square) > 0)) throw new Error("@honua/geometry area returned a non-positive value");
  const mercator = project(square, 4326, 3857);
  if (mercator.type !== "Polygon" || Math.abs(mercator.coordinates[0][2][0]) < 1000)
    throw new Error("@honua/geometry project did not reproject to Web Mercator meters");
  const back = toWgs84(mercator, 3857);
  if (Math.abs(back.coordinates[0][2][0] - 1) > 1e-6)
    throw new Error("@honua/geometry toWgs84 round-trip drifted");
}
if (typeof geometryEngineCompat !== "object" || typeof geometryEngineCompat.buffer !== "function")
  throw new Error("geometryEngineCompat export missing from @honua/sdk-esri-compat");
{
  const point = { x: 0, y: 0, spatialReference: { wkid: 3857 } };
  const disk = geometryEngineCompat.buffer(point, 100, "meters");
  if (!disk || !Array.isArray(disk.rings)) throw new Error("geometryEngineCompat.buffer did not return an Esri polygon");
}

console.log("splitPackageSmoke=ok");
`.trimStart();
  fs.writeFileSync(path.join(tempRoot, "smoke.mjs"), smokeScript, "utf8");

  runCommand("npm", ["install", "--ignore-scripts", "--no-package-lock", "--silent"], tempRoot);
  const smokeResult = runCommand("node", ["smoke.mjs"], tempRoot);
  process.stdout.write(smokeResult.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    // Node >=20.12 refuses to spawn .cmd shims (npm) without a shell
    // (CVE-2024-27980); same pattern as examples/*/mock-server.mjs. Both
    // commands ("npm", "node") and their arguments are static strings.
    shell: process.platform === "win32",
  });

  if (result.error) {
    process.stderr.write(`${command} ${args.join(" ")} failed to start: ${result.error.message}\n`);
    process.exit(1);
  }

  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result;
}
