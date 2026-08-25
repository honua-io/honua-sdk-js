import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { JSDOM } = await import(pathToFileURL(process.env.HONUA_PACKED_JSDOM_ENTRY).href);
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://packed-consumer.example.test/",
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
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
      writable: true,
    });
  }
}

const webComponents = await import("@honua/app-platform/web-components");
const {
  HonuaFeatureEditorElement,
  HonuaFeatureTableElement,
  HonuaPrintExportElement,
  createHonuaApplicationContext,
  createHonuaFeatureTable,
  mountHonuaApplication,
  runHonuaExport,
} = webComponents;
assert.equal(typeof HonuaFeatureEditorElement, "function");
assert.equal(typeof HonuaFeatureTableElement, "function");
assert.equal(typeof HonuaPrintExportElement, "function");
assert.equal(typeof createHonuaApplicationContext, "function");
assert.equal(typeof createHonuaFeatureTable, "function");
assert.equal(typeof mountHonuaApplication, "function");
assert.equal(typeof runHonuaExport, "function");
assert.equal(customElements.get("honua-feature-editor"), HonuaFeatureEditorElement);
assert.equal(customElements.get("honua-feature-table"), HonuaFeatureTableElement);
assert.equal(customElements.get("honua-print-export"), HonuaPrintExportElement);

const applicationHost = document.createElement("main");
document.body.append(applicationHost);
const applicationContext = createHonuaApplicationContext({ status: "ready" });
const mountedApplication = await mountHonuaApplication({
  host: applicationHost,
  context: applicationContext,
});
assert.equal(mountedApplication.context, applicationContext);
assert.equal(mountedApplication.disposed, false);
assert.equal(applicationHost.getAttribute("data-honua-status"), "ready");
mountedApplication.dispose();
assert.equal(mountedApplication.disposed, true);
applicationContext.dispose();
applicationHost.remove();

const editor = document.createElement("honua-feature-editor");
document.body.append(editor);
assert.match(editor.shadowRoot?.textContent ?? "", /No edit workflow is attached/);
editor.remove();

const logicalRowCount = 50_000;
const pageSize = 25;
const tableQueries = [];
const tableEngine = createHonuaFeatureTable({
  sourceId: "packed-records",
  source: {
    descriptor: {
      id: "packed-records",
      protocol: "ogc-features",
      locator: { url: "https://packed-consumer.example.test/ogc/features", collectionId: "records" },
      capabilities: new Set(["query"]),
      schema: { primaryKey: "id" },
    },
    async query(request = {}) {
      tableQueries.push(request);
      const offset = request.pagination?.offset ?? 0;
      const limit = request.pagination?.limit ?? pageSize;
      const features = Array.from({ length: Math.min(limit, logicalRowCount - offset) }, (_unused, index) => ({
        attributes: { id: offset + index + 1, name: `Packed record ${offset + index + 1}` },
      }));
      return {
        features,
        totalCount: logicalRowCount,
        exceededTransferLimit: offset + features.length < logicalRowCount,
      };
    },
  },
  columns: [
    { field: "id", label: "ID", type: "integer" },
    { field: "name", label: "Name", type: "string" },
  ],
  budgets: { pageSize, maxCachedRows: 50, maxRequests: 4, windowOverscan: 0 },
  planner: () => ({
    id: "packed-table-plan",
    fingerprint: "sha256:packed-table-plan",
    pushdown: "full",
    fidelity: "exact",
    estimates: { rows: logicalRowCount },
    steps: [
      {
        id: "packed-remote-page",
        engine: "remote",
        operation: "query",
        pushdown: "full",
        fidelity: "exact",
        reason: "OGC Features filter, sort, and page are server-executed",
      },
    ],
  }),
});
const table = document.createElement("honua-feature-table");
table.table = tableEngine;
document.body.append(table);
await tableEngine.refresh();
assert.equal(tableQueries.length, 1);
assert.equal(table.shadowRoot?.querySelector("[role='grid']")?.getAttribute("aria-rowcount"), "50001");
assert.equal(table.shadowRoot?.querySelectorAll("tbody tr[data-row-key]").length, pageSize);
assert.equal(table.shadowRoot?.querySelector("[data-work-tier='server']")?.textContent, "Server · 1");
assert.match(table.shadowRoot?.querySelector("[data-work-tier='client']")?.textContent ?? "", /^Client · /);

await tableEngine.setScroll({ scrollTop: 40_000 * 32, rowHeight: 32, viewportHeight: 10 * 32 });
assert.equal(tableQueries.length, 2);
assert.equal(table.shadowRoot?.querySelectorAll("tbody tr[data-row-key]").length, 10);
assert.ok(tableEngine.snapshot.count.loaded <= 50);
tableEngine.select(tableEngine.keysForTargets([{ sourceId: "packed-records", id: 49_999 }]));
assert.deepEqual(tableEngine.selectionTargets(), [{ sourceId: "packed-records", id: 49_999 }]);
table.remove();
tableEngine.dispose();

const print = document.createElement("honua-print-export");
document.body.append(print);
const unsupported = await print.requestExport("snapshot");
assert.equal(unsupported.status, "unsupported");
assert.equal(unsupported.bytes, undefined);
assert.equal(unsupported.text, undefined);
assert.equal(unsupported.error?.sdkCode, "core.capability-not-supported");
assert.match(print.shadowRoot?.textContent ?? "", /explicit export adapter/);

const secret = "Bearer packed-consumer-secret";
let adapterState;
const secured = await runHonuaExport({
  kind: "state",
  state: {
    packageId: "packed-consumer",
    status: "ready",
    layers: [{ id: "safe-layer", title: "Safe layer", visible: true, metadata: { authorization: secret } }],
    legend: [],
    viewport: { center: [0, 0], zoom: 1 },
    featuresBySource: {},
    featureStates: [],
    filters: {},
  },
  adapter: {
    id: "packed-security-probe",
    describeCapabilities: () => ({ adapterId: "packed-security-probe", kinds: ["state"], cancellable: false }),
    exportState: (context) => {
      adapterState = context.state;
      return { mediaType: "application/json", text: JSON.stringify(context.state) };
    },
  },
});
assert.equal(secured.status, "ready");
assert.ok((secured.redactions?.length ?? 0) > 0);
assert.doesNotMatch(JSON.stringify(adapterState), /packed-consumer-secret/);
assert.doesNotMatch(secured.text ?? "", /packed-consumer-secret/);

console.log(
  "packedAppPlatformComponents=ok productionFeatureEditor=mounted boundedFeatureTable=50000rows exportCapabilityFailure=closed securityRedaction=proved",
);
