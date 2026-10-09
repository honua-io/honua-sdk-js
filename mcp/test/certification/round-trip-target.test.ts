import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CertificationReport, certify } from "../../src/certification/certifier.js";
import {
  SERVICE_BOUND_TOOLS,
  discoverRoundTripTarget,
  firstPublishedLayer,
  withoutServiceBoundInputs,
} from "../../src/certification/round-trip-target.js";
import { type CertificationTarget, openCertificationTarget } from "../../src/certification/target.js";

const ADVERTISED = new Set(["honua_list_layers"]);

function stubClient(result: unknown | Error): Pick<Client, "callTool"> {
  return {
    callTool: (async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }) as unknown as Client["callTool"],
  };
}

/** Wrap a real client so honua_list_layers answers with `layers`, everything else passes through. */
function withListedLayers(client: Client, layers: unknown[]): Client {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "callTool") {
        return async (req: { name: string }, ...rest: unknown[]) =>
          req.name === "honua_list_layers"
            ? { structuredContent: { layers }, content: [{ type: "text", text: JSON.stringify({ layers }) }] }
            : (target.callTool as (...a: unknown[]) => unknown)(req, ...rest);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("round-trip target discovery (unit)", () => {
  it("picks the first layer with a service id and a non-negative integer layer id", () => {
    expect(
      firstPublishedLayer({
        layers: [
          { name: "no ids" },
          { service_id: "zero_to_map_parcels", layer_id: "0" },
          { serviceId: "b", layerId: 1 },
        ],
      }),
    ).toEqual({ serviceId: "zero_to_map_parcels", layerId: 0 });
    expect(firstPublishedLayer({ layers: [] })).toBeUndefined();
    expect(firstPublishedLayer({ layers: [{ serviceId: "a", layerId: -1 }] })).toBeUndefined();
    expect(firstPublishedLayer(null)).toBeUndefined();
  });

  it("binds to the first published layer from structuredContent or JSON text", async () => {
    const structured = await discoverRoundTripTarget(
      stubClient({ structuredContent: { layers: [{ serviceId: "parcels", layerId: 2, name: "Parcels" }] } }),
      ADVERTISED,
    );
    expect(structured).toMatchObject({ status: "passed", serviceId: "parcels", layerId: 2 });

    const text = await discoverRoundTripTarget(
      stubClient({ content: [{ type: "text", text: JSON.stringify({ layers: [{ serviceId: "s", layerId: 0 }] }) }] }),
      ADVERTISED,
    );
    expect(text).toMatchObject({ status: "passed", serviceId: "s", layerId: 0 });
  });

  it("is blocked, never passed, when no layer can be discovered", async () => {
    const cases = [
      await discoverRoundTripTarget(stubClient({ structuredContent: { layers: [] } }), ADVERTISED),
      await discoverRoundTripTarget(stubClient({ isError: true, content: [] }), ADVERTISED),
      await discoverRoundTripTarget(stubClient(new Error("boom")), ADVERTISED),
      await discoverRoundTripTarget(stubClient({ structuredContent: { layers: [] } }), new Set()),
    ];
    for (const resolution of cases) {
      expect(resolution.status).toBe("blocked");
    }
    expect(cases[0]?.detail).toMatch(/no published layer/);
    expect(cases[3]?.detail).toMatch(/not advertised/);
  });

  it("drops only the service-bound fixtures", () => {
    const inputs = Object.fromEntries([...SERVICE_BOUND_TOOLS, "honua_list_layers"].map((n) => [n, {}]));
    expect(Object.keys(withoutServiceBoundInputs(inputs))).toEqual(["honua_list_layers"]);
  });
});

describe("round-trip target discovery (certifier, offline operator upstream)", () => {
  let target: CertificationTarget;

  beforeAll(async () => {
    target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "offline" } as NodeJS.ProcessEnv);
  }, 30_000);

  afterAll(async () => {
    await target.close();
  });

  function run(client: Client, env: Record<string, string>): Promise<CertificationReport> {
    return certify({
      client,
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      env: { ...process.env, ...env, HONUA_MCP_SERVICE_ID: "discover" } as NodeJS.ProcessEnv,
    });
  }

  it("binds the round trips to the discovered layer and passes", async () => {
    const report = await run(target.client, {});
    const contract = report.contracts.find((c) => c.contract === "round-trip-target");
    expect(contract).toMatchObject({ status: "passed" });
    expect(contract?.detail).toContain("svc-parks layer 0");
    expect(report.tools.find((t) => t.name === "honua_query_features")?.roundTrip).toBe("passed");
    expect(report.summary.pass).toBe(true);
  }, 30_000);

  it("reports blocked and keeps the summary from passing when the candidate publishes nothing", async () => {
    const report = await run(withListedLayers(target.client, []), {});
    const contract = report.contracts.find((c) => c.contract === "round-trip-target");
    expect(contract).toMatchObject({ status: "blocked" });
    expect(report.summary.contractsBlocked).toBeGreaterThanOrEqual(1);
    expect(report.summary.pass).toBe(false);
    // No service-bound tool is called with a made-up id, so nothing fails for it.
    for (const name of SERVICE_BOUND_TOOLS) {
      const tool = report.tools.find((t) => t.name === name);
      if (tool) {
        expect(tool.roundTrip).toBe("skipped");
        expect(tool.errors).toEqual([]);
      }
    }
    expect(report.contracts.find((c) => c.contract === "query-pagination")?.status).toBe("skipped");
  }, 30_000);

  it("emits no round-trip-target contract without the discover sentinel", async () => {
    const report = await certify({
      client: target.client,
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      env: { ...process.env, HONUA_MCP_SERVICE_ID: "svc-parks" } as NodeJS.ProcessEnv,
    });
    expect(report.contracts.some((c) => c.contract === "round-trip-target")).toBe(false);
  }, 30_000);
});
