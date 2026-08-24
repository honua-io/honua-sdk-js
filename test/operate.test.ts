import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HonuaClient } from "../src/index.js";
import { HONUA_OPERATE_BASE_PATH, HonuaOperateClient, createHonuaOperate } from "../src/operate/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/operate");

interface Fixture {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));
}

function clientForFixture(
  contract: Fixture,
  capture?: Array<{ method: string; path: string; body?: unknown }>,
): HonuaOperateClient {
  return createHonuaOperate({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        capture?.push({
          method: String(init?.method ?? "GET"),
          path: `${url.pathname}${url.search}`,
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        });
        const body = contract.response.body === undefined ? null : JSON.stringify(contract.response.body);
        return new Response(body, { status: contract.response.status, headers: contract.response.headers });
      },
    }),
  });
}

describe("operate observability client", () => {
  it("exports the experimental subpath constants and factory", () => {
    expect(HONUA_OPERATE_BASE_PATH).toBe("/api/v1/operate");
    expect(createHonuaOperate).toBeTypeOf("function");
    expect(HonuaOperateClient).toBeTypeOf("function");
  });

  it("reads healthy server telemetry status with validators", async () => {
    const contract = fixture("telemetry-status-healthy.v1.json");
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const operate = clientForFixture(contract, requests);

    const result = await operate.telemetry.status("server-prod");

    expect(requests[0]).toEqual({ method: "GET", path: contract.request.path });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.health).toBe("healthy");
    expect(result.value.telemetryEnabled).toBe(true);
    expect(result.value.providers?.some((provider) => provider.kind === "otlp" && provider.connected)).toBe(true);
  });

  it("represents disabled telemetry distinctly from a failing target", async () => {
    const contract = fixture("telemetry-disabled.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.telemetry.status("server-edge");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.telemetryEnabled).toBe(false);
    expect(result.value.health).toBe("unknown");
  });

  it("queries alerts and exposes state-driven available actions", async () => {
    const contract = fixture("alert-critical-active.v1.json");
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const operate = clientForFixture(contract, requests);

    const result = await operate.alerts.query({ limit: 2, targetId: "server-prod" });

    expect(requests[0]?.path).toBe(contract.request.path);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const alert = result.value.items[0];
    expect(alert?.severity).toBe("critical");
    expect(alert?.status).toBe("firing");
    expect(alert?.availableActions).toContain("acknowledge");
    expect(alert?.availableActions).not.toContain("unsuppress");
    expect(result.value.validator?.etag).toBe('"alerts-v1"');
  });

  it("carries suppression metadata and a reduced action set for suppressed alerts", async () => {
    const contract = fixture("alert-suppressed.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.alerts.get("alert-disk-014");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.status).toBe("suppressed");
    expect(result.value.suppression?.until).toBe("2026-05-28T18:00:00Z");
    expect(result.value.availableActions).toContain("unsuppress");
    expect(result.value.availableActions).not.toContain("suppress");
  });

  it("sends If-Match when acting on an alert", async () => {
    const headers: Array<Headers> = [];
    const operate = createHonuaOperate({
      client: new HonuaClient({
        baseUrl: "https://example.test",
        fetchFn: async (_input, init) => {
          headers.push(new Headers(init?.headers));
          return new Response(JSON.stringify({ id: "alert-cpu-001", status: "acknowledged", availableActions: [] }), {
            status: 200,
          });
        },
      }),
    });

    const result = await operate.alerts.act("alert-cpu-001", { action: "acknowledge", ifMatch: '"alert-v9"' });

    expect(headers[0]?.get("If-Match")).toBe('"alert-v9"');
    expect(result.supported).toBe(true);
  });

  it("exposes realtime geofence alert rules with channel bindings", async () => {
    const contract = fixture("alert-rule-geofence.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.alertRules.get("rule-fleet-geofence");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.kind).toBe("geofence");
    expect(result.value.realtime).toBe(true);
    expect(result.value.geofenceZoneId).toBe("zone-service-area");
  });

  it("surfaces explicit delivery-channel errors on rule bindings", async () => {
    const contract = fixture("delivery-failure.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.alertRules.get("rule-webhook-prod");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    const binding = result.value.channelBindings?.[0];
    expect(binding?.lastDeliveryState).toBe("failed");
    expect(binding?.lastError?.status).toBe(502);
    expect(binding?.lastError?.code).toBe("delivery_channel_error");
  });

  it("evaluates an alert-rule draft using the exact admin method, path, and payload", async () => {
    const draft = {
      rule: {
        serviceId: "places",
        layerId: 7,
        ruleName: "High temperature",
        triggerType: "threshold" as const,
        conditionsJson: JSON.stringify({ field: "temperature", operator: "gt", value: 40 }),
      },
    };
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const operate = clientForFixture(
      {
        request: { method: "POST", path: "/api/v1/admin/alerts/rules/test", body: draft },
        response: {
          status: 200,
          body: {
            success: true,
            data: {
              isValid: true,
              errors: [],
              warnings: [],
              deliveryChannels: [],
              evaluatedAt: "2026-08-24T00:00:00Z",
            },
          },
        },
      },
      requests,
    );

    const result = await operate.alertRules.test(draft);

    expect(requests[0]).toEqual({ method: "POST", path: "/api/v1/admin/alerts/rules/test", body: draft });
    expect(result.supported && result.value.isValid).toBe(true);
  });

  it("rejects a malformed alert-rule test response envelope", async () => {
    const operate = clientForFixture({
      request: { method: "POST", path: "/api/v1/admin/alerts/rules/test" },
      response: { status: 200, body: { success: true } },
    });
    await expect(operate.alertRules.test({ rule: {} as never })).rejects.toThrowError(/missing data/u);
  });

  it("keeps the legacy persisted-rule signature with an explicit migration error", () => {
    const operate = clientForFixture({ request: { method: "POST", path: "" }, response: { status: 500 } });

    expect(() => operate.alertRules.test("rule-123")).toThrowError(
      /pass \{ rule, zone\? \}.*POST \/api\/v1\/admin\/alerts\/rules\/test/u,
    );
  });

  it("reads job detail with stages and state-driven actions", async () => {
    const contract = fixture("job-running.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.jobs.get("job-tile-bake-101");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.state).toBe("running");
    expect(result.value.availableActions).toEqual(["cancel"]);
    expect(result.value.stages?.find((s) => s.id === "bake")?.state).toBe("running");
  });

  it("links a retried job back to its prior run", async () => {
    const contract = fixture("job-retried.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.jobs.get("job-import-201");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.state).toBe("retrying");
    expect(result.value.retryOfRunId).toBe("job-import-200");
  });

  it("lists artifacts for an artifact-producing job", async () => {
    const contract = fixture("job-artifacts.v1.json");
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const operate = clientForFixture(contract, requests);

    const result = await operate.jobs.artifacts("job-export-300");

    expect(requests[0]?.path).toBe(contract.request.path);
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.items).toHaveLength(2);
    expect(result.value.items[0]?.contentType).toBe("application/geo+json");
  });

  it("reads an investigation timeline with pinned items", async () => {
    const contract = fixture("investigation-timeline.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.investigations.get("inv-outage-42");

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.pinnedItemIds).toContain("alert-cpu-001");
    expect(result.value.timeline?.[0]?.kind).toBe("alert");
    expect(result.value.timeline?.[0]?.pinned).toBe(true);
  });

  it("degrades to a typed unsupported result when logs are not configured (501)", async () => {
    const contract = fixture("unsupported-logs.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.logs.query();

    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.capability).toBe("logs");
    expect(result.statusCode).toBe(501);
    expect(result.reason).toContain("no log store");
  });

  it("degrades to a typed unsupported result when investigations are not provisioned (404)", async () => {
    const contract = fixture("unsupported-investigations.v1.json");
    const operate = clientForFixture(contract);

    const result = await operate.investigations.create({ title: "New investigation" });

    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.capability).toBe("investigations");
    expect(result.statusCode).toBe(404);
    expect(result.problem?.code).toBe("capability_unavailable");
  });
});
