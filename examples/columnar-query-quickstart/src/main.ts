import { openColumnarSession } from "@honua/sdk-js/columnar-workflow";
import "./style.css";

const session = openColumnarSession({
  kind: "honua-feature-query",
  id: "parcel-subset",
  baseUrl: "https://example.invalid/",
  serviceId: "Parcels",
  layerId: 0,
  format: "arrow",
  sourceVersion: "example-v1",
  schemaVersion: "example-v1",
  authorizationScope: "public",
}, {
  budgets: {
    maxRows: 5_000,
    maxBatches: 16,
    maxTransferBytes: 8 * 1024 * 1024,
    maxBackingBytes: 16 * 1024 * 1024,
  },
});

const plan = session.plan({
  columns: ["zone", "assessed_value"],
  bbox: [-158.1, 21.2, -157.6, 21.8],
  filter: {
    kind: "comparison",
    operator: "gte",
    left: { kind: "property", name: "assessed_value" },
    right: { kind: "literal", value: 1_000_000 },
  },
  orderBy: [{ field: "assessed_value", direction: "desc" }],
  limit: 1_000,
});

const output = document.querySelector<HTMLPreElement>("#result");
if (output) {
  output.textContent = JSON.stringify({
    execution: plan.execution,
    pushedToServer: plan.pushdown,
    remainsInBrowser: plan.browser,
    ceilings: plan.boundedBy,
    request: plan.request,
    note: "Planning is deterministic and performs no network request.",
  }, null, 2);
}
