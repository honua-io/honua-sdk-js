import type { ConnectProtocolHint } from "@honua/sdk-js";

import { resolveFirstMapConfig } from "../../examples/maplibre-quickstart/src/first-map-config.js";
import { runFirstMapWorkflow } from "../../examples/maplibre-quickstart/src/workflow.js";
import { FirstMapTestMap } from "./first-map-test-map.js";

type FirstMapProtocol = Extract<ConnectProtocolHint, "auto" | "ogc-features">;

export async function captureFirstMapSemantics(
  endpoint: string,
  protocol: FirstMapProtocol,
  sourceId?: string,
): Promise<unknown> {
  const result = await runFirstMapWorkflow(
    resolveFirstMapConfig({ endpoint, mode: "fixture", protocol, ...(sourceId ? { sourceId } : {}), maxFeatures: 3 }),
    { map: new FirstMapTestMap() },
  );
  if (result.state !== "ready") throw new Error(`First Map parity expected ready, received ${result.state}.`);
  try {
    const remote = result.plan.steps.find((step) => step.engine === "remote");
    return {
      state: result.state,
      source: {
        protocol: result.view.source.protocol,
        id: result.view.source.id,
        capabilities: result.view.source.capabilities,
      },
      plan: {
        id: result.plan.id,
        fingerprint: result.plan.fingerprint,
        pushdown: result.plan.pushdown,
        compiled: remote?.compiled,
        warnings: result.plan.warnings.map(({ code, severity, path }) => ({ code, severity, path })),
      },
      query: {
        features: result.query.features,
        exceededTransferLimit: result.query.exceededTransferLimit,
        totalCount: result.query.totalCount,
        receipt: {
          plan: result.query.execution.plan,
          observation: {
            protocol: result.query.execution.observation.protocol,
            discovery: result.query.execution.observation.discovery,
            cacheStatus: result.query.execution.observation.cacheStatus,
          },
          terminal: result.query.execution.terminal,
        },
      },
      mount: result.mounted.diagnostics.map(({ code, severity, strategy }) => ({ code, severity, strategy })),
    };
  } finally {
    await result.dispose();
  }
}
