---
type: reference
title: "Operator Components"
description: "Framework-neutral operator controllers and the workspace orchestrator: chat, clarification, plan review, execution, map and builder workspaces, and approvals."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Operator Components

> **Native application path:** [gRPC for live data and edits; PMTiles, GeoParquet and COG through the CDN](native-data-paths.md). Start there for browser gRPC-Web setup, signed private URLs and regeneration after changes. OGC API and GeoServices REST examples below are compatibility workflows.

The operator module exposes framework-neutral controllers and a workspace
orchestrator under `@honua/app-platform/operator`. Hosts can render the surfaces in
React, Web Components, plain DOM, or native shells while reusing the same state
and transport contract.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { OperatorWorkspace } from "@honua/app-platform/operator";
import { HonuaClient } from "@honua/sdk-js";

const workspace = new OperatorWorkspace({
  client: operatorClient,
  mapFactory: () => ({ map }),
  mapLoadOptions: {
    client: new HonuaClient({ baseUrl: "https://api.example.test" }),
    skipCompatibilityCheck: false,
  },
});

workspace.on((event) => {
  switch (event.kind) {
    case "clarification-needed":
      renderClarificationForm(event.intent);
      break;
    case "plan-loaded":
      renderPlanReview(event.plan);
      break;
    case "map-loaded":
      showMapPreview(event.pkg);
      break;
    case "approval-required":
      renderApprovalGate(event.decision);
      break;
  }
});
```

The workspace composes six controller surfaces:

- `ChatController` streams a freeform user request into a drafted operator intent.
- `ClarificationController` submits typed clarification answers back through the shared client.
- `PlanReviewController` loads, revises, and accepts server-produced plans without mutating steps locally.
- `ExecutionController` adapts the shared `IJobRun` contract and emits every progress and terminal transition.
- `MapWorkspaceController` loads result `HonuaMapDocument` objects through the runtime instead of owning MapLibre source/style logic.
- `BuilderWorkspaceController` exposes app package preview handles for host-owned sandbox rendering.
- `ApprovalController` surfaces server-rendered policy decisions and never upgrades deferred or denied outcomes locally.

The public extension points are controller subscriptions, workspace events,
theme tokens, and message catalogs. The module intentionally does not expose
feature editing or client-side policy override affordances.
