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
const { HonuaFeatureEditorElement, HonuaPrintExportElement, runHonuaExport } = webComponents;
assert.equal(typeof HonuaFeatureEditorElement, "function");
assert.equal(typeof HonuaPrintExportElement, "function");
assert.equal(typeof runHonuaExport, "function");
assert.equal(customElements.get("honua-feature-editor"), HonuaFeatureEditorElement);
assert.equal(customElements.get("honua-print-export"), HonuaPrintExportElement);

const editor = document.createElement("honua-feature-editor");
document.body.append(editor);
assert.match(editor.shadowRoot?.textContent ?? "", /No edit workflow is attached/);
editor.remove();

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

console.log("packedAppPlatformComponents=ok productionFeatureEditor=mounted exportCapabilityFailure=closed securityRedaction=proved");
