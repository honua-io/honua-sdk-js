import "./worker.js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { esriToGeoJson, geoJsonToEsri } from "@honua/geometry";
import type { GeoJsonGeometry } from "@honua/geometry";
import { createHonua } from "@honua/sdk-js";
import type { CanonicalFeature, Source } from "@honua/sdk-js/contract";
import {
  createFeatureEditorWorkflow,
  createTerraDrawEditorSketch,
  defineHonuaFeatureEditor,
  editorDomainFromSchema,
  editorFieldsFromSchema,
} from "@honua/sdk-js/web-components";
import type {
  HonuaEditorSchemaDomainLike,
  HonuaEditorSchemaFieldLike,
  HonuaEditorSubtypeConfig,
  HonuaFeatureEditorElement,
  HonuaFeatureEditorWorkflow,
} from "@honua/sdk-js/web-components";
import type { FeatureCollection, Geometry } from "geojson";
import { Map as LibreMap, NavigationControl } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import { localLayerUrl } from "./bindings.js";

interface LayerMetadata {
  fields: HonuaEditorSchemaFieldLike[];
  objectIdField: string;
  geometryType: string;
  extent?: { spatialReference?: { wkid?: number; latestWkid?: number } };
  typeIdField?: string;
  types?: {
    id: string | number;
    name: string;
    domains?: Record<string, HonuaEditorSchemaDomainLike | null>;
    templates?: { prototype?: { attributes?: Record<string, unknown> } }[];
  }[];
}
interface Layer {
  name: string;
  source: Source;
  metadata: LayerMetadata;
  features: CanonicalFeature[];
  workflow: HonuaFeatureEditorWorkflow;
  color: string;
}
const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
};
const status = element("status");
const error = element("error");
const selector = element<HTMLSelectElement>("layer");
const search = element<HTMLInputElement>("search");
const reload = element<HTMLButtonElement>("reload");
const honua = createHonua();
const layers: Layer[] = [];
let active: Layer | undefined;
let sketch: Awaited<ReturnType<typeof createTerraDrawEditorSketch>> | undefined;
let switching = false;
const fail = (cause: unknown) => {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
};
const map = new LibreMap({
  container: "map",
  style: import.meta.env.VITE_BASEMAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty",
  center: [-80.839, 35.226],
  zoom: 13,
});
map.addControl(new NavigationControl());
defineHonuaFeatureEditor();
const editor = document.createElement("honua-feature-editor") as HonuaFeatureEditorElement;
element("editor").append(editor);

// This experiment may mutate only explicitly bound, loopback Honua imports.
// The Vite proxy injects local authentication server-side for an allowlist.

function subtypes(metadata: LayerMetadata): HonuaEditorSubtypeConfig {
  if (!metadata.typeIdField || !metadata.types?.length) {
    throw new Error("Imported subtype metadata is missing; reconcile the service before enabling editing.");
  }
  return {
    field: metadata.typeIdField,
    defaultCode: metadata.types[0].id,
    subtypes: metadata.types.map((type) => {
      const defaults = type.templates?.[0]?.prototype?.attributes ?? {};
      const fields = new Set([...Object.keys(type.domains ?? {}), ...Object.keys(defaults)]);
      return {
        code: type.id,
        name: type.name,
        fieldOverrides: Object.fromEntries(
          [...fields].map((name) => {
            const raw = type.domains?.[name];
            const domain = editorDomainFromSchema(raw);
            return [
              name,
              {
                ...(raw === null ? { domain: null } : domain ? { domain } : {}),
                ...(name in defaults ? { defaultValue: defaults[name] } : {}),
              },
            ];
          }),
        ),
      };
    }),
  };
}

async function readFeatures(layer: Layer): Promise<void> {
  const signal = AbortSignal.timeout(120_000);
  const features: CanonicalFeature[] = [];
  const seen = new Set<string>();
  const key = layer.source.descriptor.schema?.primaryKey ?? layer.metadata.objectIdField;
  if (!key) throw new Error("Imported layer has no primary key.");
  const expected = await layer.source.queryObjectIds({ signal });
  for await (const page of layer.source.stream({
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    orderBy: [{ field: key, direction: "asc" }],
    pagination: { limit: 1000 },
    signal,
  })) {
    if (page.degraded?.length) throw new Error(`Incomplete ${layer.name} query`);
    for (const row of page.features) {
      const id = row.attributes[key];
      if ((typeof id !== "string" && typeof id !== "number") || seen.has(String(id)))
        throw new Error("Missing or duplicate feature ID");
      const feature: CanonicalFeature = {
        id,
        attributes: row.attributes,
        geometry: row.geometry ? { ...row.geometry } : null,
      };
      if (!esriToGeoJson(feature.geometry)) throw new Error("Missing feature geometry");
      seen.add(String(feature.id));
      features.push(feature);
      if (features.length > 10_000) throw new Error("Editor cohort exceeds its reviewed 10,000-feature budget.");
    }
    status.textContent = `Loading ${layer.name}: ${features.length} features`;
  }
  if (features.length !== expected.length || expected.some((id) => !seen.has(String(id)))) {
    throw new Error(`Feature identities changed while reading ${layer.name}; reload to reconcile.`);
  }
  layer.features = features;
}

function collection(layer: Layer): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: layer.features.map((feature) => ({
      type: "Feature",
      id: String(feature.id),
      geometry: esriToGeoJson(feature.geometry) as Geometry,
      properties: { __honua_id: String(feature.id) },
    })),
  };
}
function list(): void {
  if (!active) return;
  const query = search.value.toLowerCase();
  const matches = active.features.filter((feature) => label(feature).toLowerCase().includes(query));
  element("count").textContent = `${matches.length} of ${active.features.length} features; first 100 listed`;
  element("features").replaceChildren(
    ...matches.slice(0, 100).map((feature) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label(feature);
      button.onclick = () => {
        void selectFeature(feature).catch(fail);
      };
      return button;
    }),
  );
}
function label(feature: CanonicalFeature): string {
  const values = Object.entries(feature.attributes)
    .filter(([key]) => /^(description|descrip|hazardtype|status|fullclose)$/i.test(key))
    .map(([, value]) => String(value ?? ""))
    .filter(Boolean);
  return `#${feature.id} ${values.join(" · ")}`;
}
async function selectFeature(feature: CanonicalFeature): Promise<void> {
  const layer = active;
  if (!layer || layer.workflow.snapshot().form) {
    status.textContent = "Save or cancel the current draft before selecting another feature.";
    return;
  }
  layer.workflow.setSelection(feature);
  element("selected").textContent = label(feature);
  const host = element("attachments");
  host.replaceChildren();
  if (!layer.workflow.snapshot().attachmentsSupported || feature.id === undefined) return;
  const attachments = await layer.source.attachments.list(feature.id, { signal: AbortSignal.timeout(30_000) });
  if (active !== layer || layer.workflow.selection()?.id !== feature.id) return;
  for (const attachment of attachments) {
    const item = document.createElement("li");
    item.textContent = `${attachment.name} (${attachment.size ?? "unknown"} bytes)`;
    host.append(item);
  }
  if (!attachments.length) host.textContent = "No saved attachments";
}

async function activate(index: number): Promise<void> {
  if (switching) return;
  if (active?.workflow.snapshot().form) {
    selector.value = String(layers.indexOf(active));
    status.textContent = "Save or cancel the current draft before changing layers.";
    return;
  }
  switching = true;
  selector.disabled = true;
  try {
    sketch?.stop();
    sketch = undefined;
    active = layers[index];
    if (!active) throw new Error("Unknown editor layer");
    const workflow = active.workflow;
    editor.workflow = workflow;
    sketch = await createTerraDrawEditorSketch(map, {
      workflow,
      modes: [
        active.metadata.geometryType === "esriGeometryPoint"
          ? "point"
          : active.metadata.geometryType === "esriGeometryPolyline"
            ? "linestring"
            : "polygon",
        "select",
      ],
      transformGeometry: (geometry) => {
        const converted = geoJsonToEsri(geometry as unknown as GeoJsonGeometry, { wkid: 4326 });
        if (!converted) throw new Error("Sketch geometry cannot be converted");
        return converted as unknown as Record<string, unknown>;
      },
      restoreGeometry: (geometry) => {
        const converted = esriToGeoJson(geometry);
        if (!converted) throw new Error("Saved geometry cannot be restored for drawing");
        return converted as unknown as Record<string, unknown>;
      },
    });
    workflow.cancel();
    search.value = "";
    list();
    element("selected").textContent = `Editing ${active.name}`;
    element("attachments").replaceChildren();
    status.textContent = `${active.name}: ${active.features.length} saved features`;
  } finally {
    switching = false;
    selector.disabled = false;
  }
}

async function start(): Promise<void> {
  const bindings = [
    ["Hazards", import.meta.env.VITE_HAZARDS_URL, "#e05530"],
    ["Road closures", import.meta.env.VITE_ROADS_URL, "#6842b8"],
    ["Hazard areas", import.meta.env.VITE_AREAS_URL, "#d49822"],
  ];
  const urls = bindings.map(([, url]) => localLayerUrl(url, location.origin));
  for (const [index, url] of urls.entries()) {
    const signal = AbortSignal.timeout(60_000);
    const response = await fetch(`${url}?f=json`, { signal });
    if (!response.ok) throw new Error(`Layer metadata failed: HTTP ${response.status}`);
    const raw = await response.json();
    if (raw.error || !Array.isArray(raw.fields)) throw new Error("Invalid imported layer metadata");
    const metadata = raw as LayerMetadata;
    const sr = metadata.extent?.spatialReference;
    if ((sr?.latestWkid ?? sr?.wkid) !== 4326) throw new Error("This run requires reviewed imports in EPSG:4326.");
    const connection = await honua.connect({ url, protocol: "geoservices-feature-service" }, { signal });
    const source = connection.source();
    const type = metadata.geometryType;
    const workflow = createFeatureEditorWorkflow({
      source,
      metadata: { fields: editorFieldsFromSchema(metadata.fields), primaryKey: metadata.objectIdField },
      subtypes: subtypes(metadata),
      rollbackOnFailure: true,
      sketchTools: {
        point: type === "esriGeometryPoint" ? "supported" : "unsupported",
        line: type === "esriGeometryPolyline" ? "supported" : "unsupported",
        polygon: type === "esriGeometryPolygon" ? "supported" : "unsupported",
      },
    });
    const layer: Layer = {
      name: bindings[index][0],
      color: bindings[index][2],
      source,
      metadata,
      workflow,
      features: [],
    };
    await readFeatures(layer);
    layers.push(layer);
  }
  if (!map.isStyleLoaded()) await new Promise<void>((resolve) => map.once("load", () => resolve()));
  for (const [index, layer] of layers.entries()) {
    const id = `operational-${index}`;
    map.addSource(id, { type: "geojson", data: collection(layer), promoteId: "__honua_id" });
    const type = layer.metadata.geometryType;
    if (type === "esriGeometryPoint")
      map.addLayer({
        id,
        type: "circle",
        source: id,
        paint: {
          "circle-color": layer.color,
          "circle-radius": 5,
          "circle-stroke-width": 1,
          "circle-stroke-color": "white",
        },
      });
    else if (type === "esriGeometryPolyline")
      map.addLayer({ id, type: "line", source: id, paint: { "line-color": layer.color, "line-width": 4 } });
    else map.addLayer({ id, type: "fill", source: id, paint: { "fill-color": layer.color, "fill-opacity": 0.3 } });
    map.on("click", id, (event) => {
      if (active !== layer) return;
      const feature = layer.features.find((candidate) => String(candidate.id) === String(event.features?.[0]?.id));
      if (feature) void selectFeature(feature).catch(fail);
    });
    const option = new Option(layer.name, String(index));
    selector.add(option);
  }
  selector.onchange = () => {
    void activate(Number(selector.value)).catch(fail);
  };
  search.oninput = list;
  search.disabled = false;
  reload.disabled = false;
  reload.onclick = () => {
    void refresh().catch(fail);
  };
  editor.addEventListener("honua-feature-edit-commit", () => {
    void refresh().catch(fail);
  });
  await activate(0);
}
async function refresh(): Promise<void> {
  const layer = active;
  if (!layer || (layer.workflow.snapshot().form && layer.workflow.snapshot().status !== "committed")) {
    status.textContent = "Save or cancel the current draft before reloading.";
    return;
  }
  reload.disabled = true;
  try {
    await readFeatures(layer);
    (map.getSource(`operational-${layers.indexOf(layer)}`) as GeoJSONSource).setData(collection(layer));
    if (active === layer) {
      list();
      status.textContent = `${layer.name}: reloaded ${layer.features.length} saved features`;
    }
  } finally {
    reload.disabled = false;
  }
}
window.addEventListener("pagehide", () => {
  sketch?.stop();
  for (const layer of layers) layer.workflow.cancel();
  void honua.dispose();
  map.remove();
});
void start().catch(fail);
