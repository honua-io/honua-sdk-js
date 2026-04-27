# Operator Components

The operator module exposes framework-neutral controllers and a workspace
orchestrator under `@honua/sdk-js/operator`. Hosts can render the surfaces in
React, Web Components, plain DOM, or native shells while reusing the same state
and transport contract.

```ts
import { OperatorWorkspace } from "@honua/sdk-js/operator";
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
- `MapWorkspaceController` loads result `MapPackage` objects through the runtime instead of owning MapLibre source/style logic.
- `BuilderWorkspaceController` exposes app package preview handles for host-owned sandbox rendering.
- `ApprovalController` surfaces server-rendered policy decisions and never upgrades deferred or denied outcomes locally.

The public extension points are controller subscriptions, workspace events,
theme tokens, and message catalogs. The module intentionally does not expose
feature editing or client-side policy override affordances.
