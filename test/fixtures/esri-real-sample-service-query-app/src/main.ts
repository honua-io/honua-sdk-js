import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import LayerList from "@arcgis/core/widgets/LayerList";
import Popup from "@arcgis/core/widgets/Popup";
import { HonuaClient } from "@honua/sdk";

// Real-service query/filter/paging/editing/auth-error fixture for #1662. The
// migrated compat FeatureLayer builds a real HonuaClient and issues real
// HTTP GeoServices requests (see FeatureLayerCompat in
// src/esri-compat/feature-layer.ts) against
// honua-featureserver-fixture-server.mjs — a protocol-faithful FeatureServer,
// not an in-memory mock. `HonuaClient` is imported directly from the
// installed `@honua/sdk-js` package: the codemod migrates the ArcGIS surface
// but does not auto-configure per-service credentials, so a real migration
// wires this the same way — an explicit, assisted addition alongside the
// automated rewrite, matching the corpus's own "held-back"/manual pattern.
// `@honua/sdk` is the split-package name for the installed `@honua/sdk-js`
// bytes (see `scripts/prepare-split-packages.mjs`).

// Set by the driver's HTML shell to the real fixture FeatureServer's origin;
// falls back to a same-origin relative path when the app is served from the
// same server as the FeatureServer routes.
declare const window: { __HONUA_SERVICE_URL__?: string } & typeof globalThis;
const SERVICE_URL = window.__HONUA_SERVICE_URL__ ?? "/rest/services/parcels/FeatureServer/0";
const VALID_TOKEN = "valid-token";

const anonymousLayer = new FeatureLayer({ url: SERVICE_URL, outFields: ["*"] });
let anonymousLoadRejected = false;
let anonymousLoadErrorStatusCode: number | undefined;
try {
  await anonymousLayer.load();
} catch (error) {
  anonymousLoadRejected = true;
  anonymousLoadErrorStatusCode = (error as { statusCode?: number }).statusCode;
}

const authorizedClient = new HonuaClient({ baseUrl: new URL(SERVICE_URL, location.href).origin, bearerToken: VALID_TOKEN });
const layer = new FeatureLayer({
  url: SERVICE_URL,
  outFields: ["*"],
  client: authorizedClient,
});
await layer.load();
const layerFieldCount = (layer.metadata as { fields?: unknown[] } | undefined)?.fields?.length ?? 0;

const map = new Map({ layers: [layer] });
const view = new MapView({ map, container: "viewDiv", center: [-122.4, 37.8], zoom: 10 });
const layerList = new LayerList({ view });
const popup = new Popup({ view, dockEnabled: true });

const firstPage = await layer.queryFeatures({
  where: "STATUS = 'active'",
  extraParams: { resultOffset: 0, resultRecordCount: 2 },
});
const secondPage = await layer.queryFeatures({
  where: "STATUS = 'active'",
  extraParams: { resultOffset: 2, resultRecordCount: 2 },
});
const totalActiveCount = await layer.queryFeatureCount({ where: "STATUS = 'active'" });

layer.definitionExpression = "STATUS = 'active'";
const filtered = await layer.queryFeatures();

const editResult = await layer.applyEdits({
  adds: [{ attributes: { STATUS: "active", NAME: "Hydrant F", PRIORITY: 1 } }],
});

popup.open({
  title: "Parcels",
  features: filtered.features ?? [],
  location: [-122.4, 37.8],
});

export default {
  mapCtor: map.constructor.name,
  viewCtor: view.constructor.name,
  layerCtor: layer.constructor.name,
  layerListCtor: layerList.constructor.name,
  popupCtor: popup.constructor.name,
  anonymousLoadRejected,
  anonymousLoadErrorStatusCode,
  layerFieldCount,
  firstPageObjectIds: (firstPage.features ?? []).map((feature) => feature.attributes.OBJECTID),
  secondPageObjectIds: (secondPage.features ?? []).map((feature) => feature.attributes.OBJECTID),
  totalActiveCount,
  filteredCount: (filtered.features ?? []).length,
  addedObjectId: editResult.addResults?.[0]?.objectId,
  addSucceeded: editResult.addResults?.[0]?.success,
  popupVisible: popup.visible,
};
