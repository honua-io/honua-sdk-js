import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const startedAt = performance.now();
let egressAttempts = 0;
const rejectEgress = async (input) => {
  egressAttempts += 1;
  throw new Error(`Reference workbench forbids network access: ${String(input)}`);
};
Object.defineProperty(globalThis, "fetch", { configurable: true, value: rejectEgress, writable: true });

const { JSDOM } = await import(pathToFileURL(process.env.HONUA_PACKED_JSDOM_ENTRY).href);
const dom = new JSDOM("<!doctype html><html><body><main id='workbench'></main></body></html>", {
  url: "https://packed-reference.invalid/",
});
for (const name of [
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "ShadowRoot",
  "DocumentFragment",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "AbortController",
  "AbortSignal",
  "navigator",
  "getComputedStyle",
]) {
  if (name in dom.window) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name], writable: true });
  }
}

const [{ HonuaClient }, { createDataset }, webComponents, React, reactDomServer] = await Promise.all([
  import("@honua/sdk"),
  import("@honua/sdk/contract"),
  import("@honua/app-platform/web-components"),
  import("react"),
  import("react-dom/server"),
]);

const {
  createFeatureEditorWorkflow,
  createHonuaApplicationContext,
  createHonuaFeatureInspectionFromApplicationContext,
  createHonuaFeatureTable,
  createHonuaWebComponentController,
  mountHonuaApplication,
  runHonuaExport,
} = webComponents;

const rows = [
  {
    id: 1,
    attributes: { id: 1, name: "Harbor response", status: "open", priority: 3, version: 1 },
    geometry: { type: "Point", coordinates: [-157.87, 21.31] },
  },
  {
    id: 2,
    attributes: { id: 2, name: "Kakaako utilities", status: "monitoring", priority: 2, version: 1 },
    geometry: { type: "Point", coordinates: [-157.86, 21.29] },
  },
  {
    id: 3,
    attributes: { id: 3, name: "Ala Moana shelter", status: "open", priority: 1, version: 1 },
    geometry: { type: "Point", coordinates: [-157.84, 21.3] },
  },
];
let queryCount = 0;
let editCount = 0;

const descriptor = {
  id: "incidents",
  protocol: "maplibre-geojson",
  locator: { url: "fixture://packed-reference/incidents" },
  capabilities: new Set(["query", "applyEdits"]),
  schema: {
    primaryKey: "id",
    fields: [
      { name: "id", type: "integer", alias: "ID", editable: false, nullable: false },
      { name: "name", type: "string", alias: "Name", editable: true, nullable: false },
      { name: "status", type: "string", alias: "Status", editable: true, nullable: false },
      { name: "priority", type: "integer", alias: "Priority", editable: true, nullable: false },
      { name: "version", type: "integer", alias: "Version", editable: true, nullable: false },
    ],
  },
};

const emptyAttachments = {
  add: async () => ({ parentId: 0, attachmentId: 0, success: false }),
  delete: async () => [],
  update: async () => ({ parentId: 0, attachmentId: 0, success: false }),
  list: async () => [],
  query: async () => [],
};

const fixtureSource = {
  descriptor,
  capabilities: descriptor.capabilities,
  attachments: emptyAttachments,
  async query(request = {}) {
    queryCount += 1;
    const serialized = JSON.stringify(request).toLowerCase();
    const filtered = serialized.includes("open") ? rows.filter((row) => row.attributes.status === "open") : rows;
    const offset = request.pagination?.offset ?? 0;
    const limit = request.pagination?.limit ?? filtered.length;
    const features = filtered.slice(offset, offset + limit).map((feature) => structuredClone(feature));
    return { features, totalCount: filtered.length, exceededTransferLimit: offset + features.length < filtered.length };
  },
  async queryAll(request = {}) {
    return this.query(request);
  },
  async queryAggregate() {
    return { features: [], totalCount: 0 };
  },
  async queryExtent() {
    return { extent: { xmin: -157.87, ymin: 21.29, xmax: -157.84, ymax: 21.31 }, count: rows.length };
  },
  async *stream(request = {}) {
    yield await this.query(request);
  },
  async queryObjectIds(request = {}) {
    const result = await this.query(request);
    return result.features.map((feature) => feature.id);
  },
  async applyEdits(envelope) {
    editCount += 1;
    const updated = [];
    for (const feature of envelope.updates ?? []) {
      const index = rows.findIndex((row) => row.id === feature.id);
      if (index >= 0) {
        rows[index] = structuredClone(feature);
        updated.push({ id: feature.id, success: true });
      }
    }
    return { added: [], updated, deleted: [] };
  },
  async queryRelated() {
    return { groups: [] };
  },
  protocol() {
    return undefined;
  },
  adapter() {
    return undefined;
  },
};

const client = new HonuaClient({ baseUrl: "https://zero-egress.invalid", fetchFn: rejectEgress });
const dataset = createDataset({
  id: "packed-reference",
  client,
  sources: [descriptor],
  skipCompatibilityCheck: true,
  resolveSource: (candidate) => (candidate.id === descriptor.id ? fixtureSource : undefined),
});
const source = dataset.source("incidents");
assert.ok(source, "connect: packed contract must resolve the reviewed fixture Source");
const connected = await source.query({ pagination: { limit: 3 } });
assert.equal(connected.features.length, 3, "connect: canonical Source query must return the fixture records");

const mapPackage = {
  mapPackageId: "packed-reference",
  format: "honua_map_package.v1",
  status: "Ready",
  sourceBindings: [],
  initialView: { center: [-157.86, 21.3], zoom: 11 },
  legend: [{ label: "Open incident", color: "#b42318" }],
  mapSpec: {
    version: 8,
    sources: {
      incidents: {
        type: "geojson",
        data: { type: "FeatureCollection", features: connected.features },
      },
    },
    layers: [
      {
        id: "incidents",
        source: "incidents",
        type: "circle",
        metadata: { title: "Incidents" },
        paint: { "circle-color": "#b42318", "circle-radius": 6 },
      },
    ],
  },
};
const controller = createHonuaWebComponentController({
  mapPackage,
  featuresBySource: { incidents: connected.features.map((feature) => ({ ...feature, sourceId: "incidents" })) },
  fieldsBySource: { incidents: ["id", "name", "status", "priority"] },
});
assert.equal(controller.getState().layers[0]?.id, "incidents", "map: production controller must own the map layer");

const context = createHonuaApplicationContext({
  status: "ready",
  binding: { source, sourceIdentity: "incidents" },
  authorization: { status: "authorized", principalId: "operator-a", scopes: ["incidents:read", "incidents:write"] },
  locale: { locale: "ar", direction: "rtl", status: { ready: "جاهز", offline: "غير متصل" } },
  theme: { accent: "#005ea8", reducedMotion: true },
});
const host = document.querySelector("#workbench");
assert.ok(host);

const reactMarkup = reactDomServer.renderToStaticMarkup(
  React.createElement("section", { id: "react-host", "aria-label": "React hosted component lane" },
    React.createElement("honua-feature-inspection", { id: "react-inspection" }),
  ),
);
host.insertAdjacentHTML(
  "beforeend",
  `${reactMarkup}<honua-feature-inspection id="direct-inspection"></honua-feature-inspection><honua-feature-table id="table"></honua-feature-table><honua-feature-editor id="editor"></honua-feature-editor><honua-print-export id="export"></honua-print-export>`,
);
const mounted = await mountHonuaApplication({ host, context, register: false });
assert.equal(host.getAttribute("dir"), "rtl", "locale: mount must project RTL without global state");
assert.equal(host.getAttribute("lang"), "ar", "locale: mount must project the context locale");
assert.ok(document.querySelector("#react-inspection"), "React: server markup must host the supported custom element");

const inspection = createHonuaFeatureInspectionFromApplicationContext(context, {
  presentation: { titleField: "name", fields: ["status", "priority", "version"] },
  now: () => Date.parse("2026-08-14T12:00:00Z"),
});
const directInspection = document.querySelector("#direct-inspection");
directInspection.inspection = inspection;
await inspection.openFromMapClick([
  {
    target: { sourceId: "incidents", id: 1 },
    feature: connected.features[0],
    authoritative: true,
  },
]);
assert.equal(inspection.snapshot().feature?.title, "Harbor response", "inspect: shared workflow must present the map hit");
assert.match(directInspection.shadowRoot?.textContent ?? "", /Harbor response/);

await inspection.openFromMapClick([
  { target: { sourceId: "incidents", id: 1 }, feature: connected.features[0], authoritative: true },
  { target: { sourceId: "incidents", id: 2 }, feature: connected.features[1], authoritative: true },
]);
assert.equal(inspection.snapshot().candidates.length, 2, "inspect: overlapping map hits must remain navigable");
await inspection.next();
assert.equal(inspection.snapshot().feature?.target.id, 2, "inspect: overlap navigation must preserve feature identity");

const searchState = await inspection.search("Kakaako");
const searchIndex = searchState.results.findIndex((result) => result.target.id === 2);
assert.ok(searchIndex >= 0, "inspect: bounded server search must return a source-qualified feature");
await inspection.openSearchResult(searchIndex);
assert.equal(inspection.snapshot().feature?.target.id, 2, "inspect: search selection must use the shared details contract");

const tableEngine = createHonuaFeatureTable({
  source,
  sourceId: "incidents",
  columns: [
    { field: "id", label: "ID", type: "integer" },
    { field: "name", label: "Name", type: "string" },
    { field: "status", label: "Status", type: "string" },
    { field: "priority", label: "Priority", type: "integer" },
  ],
  budgets: { pageSize: 10, maxCachedRows: 20, maxRequests: 4, windowOverscan: 0 },
});
const tableElement = document.querySelector("#table");
tableElement.table = tableEngine;
await tableEngine.refresh();
assert.equal(tableEngine.snapshot.count.loaded, 3, "table: first bounded page must use the canonical Source");
await inspection.openFromTableRow({
  target: { sourceId: "incidents", id: 3 },
  feature: connected.features[2],
  authoritative: true,
});
assert.equal(inspection.snapshot().feature?.target.id, 3, "inspect: a table row must use the shared details contract");
inspection.applyRealtime({
  kind: "upsert",
  target: { sourceId: "incidents", id: 3 },
  completeness: "patch",
  changedFields: ["status"],
  attributes: { status: "evacuated" },
});
assert.equal(
  inspection.snapshot().feature?.fields.find((field) => field.name === "status")?.value,
  "evacuated",
  "inspect: a safe realtime patch must update the open feature",
);
inspection.applyRealtime({
  kind: "upsert",
  target: { sourceId: "incidents", id: 3 },
  completeness: "patch",
  changedFields: ["not-loaded"],
  attributes: { status: "unknown" },
});
assert.equal(inspection.snapshot().status, "stale", "inspect: an ambiguous realtime patch must require refresh");
inspection.applyRealtime({ kind: "delete", target: { sourceId: "incidents", id: 3 } });
assert.equal(inspection.snapshot().status, "deleted", "inspect: a realtime delete must transition explicitly");
await tableEngine.setFilters([
  { id: "status", owner: { kind: "table", id: "reference" }, field: "status", operator: "=", value: "open", effect: "filter" },
]);
assert.equal(tableEngine.snapshot.count.loaded, 2, "filter: table filtering must execute through its production owner");

const workflow = createFeatureEditorWorkflow({
  source,
  mutationId: () => "packed-reference-edit-1",
  now: () => "2026-08-14T12:00:00.000Z",
});
const editorElement = document.querySelector("#editor");
editorElement.workflow = workflow;
workflow.setSelection(connected.features[0]);
workflow.begin("update");
workflow.setValue("status", "monitoring");
const commit = await workflow.submit();
assert.equal(commit.status, "committed", "edit: public workflow must commit through Source.applyEdits");
assert.equal(editCount, 1);
assert.equal(rows[0].attributes.status, "monitoring");
await tableEngine.refresh();

const exported = await runHonuaExport({
  kind: "state",
  state: {
    packageId: mapPackage.mapPackageId,
    status: context.snapshot.status,
    layers: controller.getState().layers,
    legend: controller.getState().legend,
    viewport: controller.getState().viewport,
    featuresBySource: { incidents: rows },
    featureStates: [],
    filters: { incidents: tableEngine.snapshot.filters },
  },
  adapter: {
    id: "packed-reference-json",
    describeCapabilities: () => ({ adapterId: "packed-reference-json", kinds: ["state"], cancellable: false }),
    exportState: ({ state }) => ({ mediaType: "application/json", text: JSON.stringify(state) }),
  },
});
assert.equal(exported.status, "ready", "export: production export owner must produce the reviewed state");
assert.match(exported.text ?? "", /packed-reference/);

assert.equal(
  context.applyRealtimeDelta({
    sourceIdentity: "incidents",
    mode: "patch",
    update: { selection: [{ sourceId: "incidents", id: 2 }], freshness: { state: "current", observedAt: "2026-08-14T12:00:01Z" } },
  }),
  true,
  "realtime: the active source identity must accept its delta",
);
context.replaceAuthorization({ status: "unauthorized", principalId: "operator-b", scopes: [] });
assert.equal(context.snapshot.status, "unauthorized", "auth: principal replacement must invalidate before display");
assert.deepEqual(context.snapshot.selection, [], "auth: previous-principal selection must not survive replacement");

for (const status of ["stale", "degraded", "offline", "failed"]) {
  context.update({ status });
  assert.equal(context.statusPresentation().status, status, `state: ${status} must use shared presentation semantics`);
}
assert.equal(context.statusPresentation("offline").label, "غير متصل");

const firstUseMs = performance.now() - startedAt;
const interactionStartedAt = performance.now();
controller.setLayerVisibility("incidents", false);
controller.setLayerVisibility("incidents", true);
const interactionMs = performance.now() - interactionStartedAt;
const domNodes = document.querySelectorAll("*").length;
assert.ok(firstUseMs <= 5_000, `first-use budget exceeded: ${firstUseMs.toFixed(1)}ms`);
assert.ok(interactionMs <= 250, `interaction budget exceeded: ${interactionMs.toFixed(1)}ms`);
assert.ok(domNodes <= 250, `DOM budget exceeded: ${domNodes} nodes`);
assert.ok(queryCount >= 3, "journey must query for connect, table, and filter stages");
assert.equal(egressAttempts, 0, "zero-egress: no network API may be invoked");

inspection.dispose();
tableEngine.dispose();
controller.destroy?.();
mounted.dispose();
context.dispose();
dom.window.close();

console.log(
  JSON.stringify({
    packedAppPlatformReferenceWorkbench: "ok",
    journey: ["connect", "map", "inspect", "filter", "edit", "table", "export"],
    lanes: ["direct-custom-element", "react-host"],
    states: ["locale-rtl", "auth-change", "stale", "degraded", "offline", "failed", "realtime"],
    budgets: { firstUseMs: Math.ceil(firstUseMs), interactionMs: Math.ceil(interactionMs), domNodes },
    egressAttempts,
  }),
);
