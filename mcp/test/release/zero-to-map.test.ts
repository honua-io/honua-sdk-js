import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ADMIN_MCP_EXCLUDED_OPERATIONS } from "@honua/sdk-js/control-plane";
import { describe, expect, it } from "vitest";
import {
  parseInstallAccessCredential,
  readJourneyMcpResource,
  requireCompletedPublishedOperation,
} from "../../src/release/zero-to-map-cli.js";
import {
  type JourneyAdapter,
  type JourneyBlockedError,
  type JourneyExecutionResult,
  ZERO_TO_MAP_CLOSED_ROSTER_ID,
  ZERO_TO_MAP_FULL_CATALOG_VIEW,
  ZERO_TO_MAP_WORKFLOW_VIEW_CONFIG_KEY,
  ZERO_TO_MAP_WORKFLOW_VIEW_ENV_KEY,
  assertRenderedPng,
  parseZeroToMapPlan,
  resolvePublishedShareUrl,
  runZeroToMapJourney,
  zeroToMapClosedRoster,
} from "../../src/release/zero-to-map.js";

const bundleRoot = fileURLToPath(new URL("../../release/zero-to-map/", import.meta.url));

async function loadPlan() {
  return parseZeroToMapPlan(JSON.parse(await readFile(`${bundleRoot}/journey.v1.json`, "utf8")) as unknown);
}

/** The closed roster and nothing else. A larger catalog is a separate case. */
function completeCatalog(
  requiredTools: readonly string[],
  inputSchema: (name: string) => Readonly<Record<string, unknown>> = () => ({ type: "object" }),
) {
  return [...new Set(requiredTools)].sort().map((name) => ({
    name,
    inputSchema: inputSchema(name),
  }));
}

describe("zero-to-map D9.3 release journey", () => {
  it("accepts only the exact secret-free installer access receipt", () => {
    const receipt = {
      status: "ready",
      profile: "gp-dev",
      directory: "/private/honua",
      baseUrl: "http://127.0.0.1:8080",
      readyUrl: "http://127.0.0.1:8080/healthz/ready",
      composeFile: "/private/honua/compose.yaml",
      envFile: "/private/honua/.env",
      mcpConfigFile: "/private/honua/.mcp.json",
      claudeDesktopConfigFile: "/private/honua/claude_desktop_config.json",
      adminKeyWritten: true,
      serverImage: "ghcr.io/honua-io/honua-server:2026.1",
      reused: false,
      accessCredential: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "honua-local-agent",
        status: "active",
        requestedGrants: ["admin:read", "admin:write"],
        effectiveGrants: ["admin:write", "admin:read"],
        canAuthenticate: true,
        referenceType: "private-env-file",
        referenceDigestSha256: "a".repeat(64),
        provisioned: true,
      },
    };
    expect(parseInstallAccessCredential(JSON.stringify(receipt))).toEqual(receipt.accessCredential);
    expect(() =>
      parseInstallAccessCredential(
        JSON.stringify({
          ...receipt,
          accessCredential: {
            ...receipt.accessCredential,
            requestedGrants: ["admin:approve", "admin:read", "admin:write"],
            effectiveGrants: ["admin:approve", "admin:read", "admin:write"],
          },
        }),
      ),
    ).toThrow("not scoped to the required release grants");
    expect(() => parseInstallAccessCredential(JSON.stringify({ ...receipt, secret: "must-not-pass" }))).toThrow(
      "unexpected or missing fields",
    );
  });

  it("ships an eight-stage plan and small deterministic GeoJSON fixtures", async () => {
    const plan = await loadPlan();
    expect(plan.stages.map((stage) => stage.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.releaseContract).toBe("honua-release#123/D9.3");

    const parcels = JSON.parse(await readFile(`${bundleRoot}/fixtures/parcels.geojson`, "utf8")) as {
      type: string;
      features: unknown[];
    };
    const zoning = JSON.parse(await readFile(`${bundleRoot}/fixtures/zoning.geojson`, "utf8")) as {
      type: string;
      features: unknown[];
    };
    expect(parcels).toMatchObject({ type: "FeatureCollection" });
    expect(parcels.features).toHaveLength(3);
    expect(zoning).toMatchObject({ type: "FeatureCollection" });
    expect(zoning.features).toHaveLength(2);

    const calledTools = plan.stages.flatMap((stage) =>
      stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
    );
    expect(calledTools).not.toEqual(
      expect.arrayContaining([
        "honua_esri_gp_list_tasks",
        "honua_esri_gp_describe_task",
        "honua_esri_gp_execute_task",
        "honua_buffer_features",
      ]),
    );
    expect(plan.stages.flatMap((stage) => stage.actions).some((action) => action.kind === "receipt")).toBe(false);

    const geoprocessing = new Map(plan.stages[3]?.actions.map((action) => [action.id, action]));
    const bufferPlan = {
      planId: "2026.1-zero-to-map-buffer",
      steps: [
        {
          stepId: "buffer-parcels",
          kind: "Geoprocess",
          processId: "analytics.buffer-aggregate",
          inputs: { layerId: "${parcelsLayerId}", distance: "25", unit: "meters" },
        },
      ],
      outputs: ["FeatureLayer"],
    };
    expect(geoprocessing.get("validate-buffer-plan")).toMatchObject({
      kind: "mcp",
      tool: "honua_validate_plan",
      arguments: { plan: bufferPlan },
    });
    expect(geoprocessing.get("execute-buffer-plan")).toMatchObject({
      kind: "mcp",
      tool: "honua_execute_plan",
      arguments: { plan: bufferPlan, idempotencyKey: "2026.1-zero-to-map-buffer" },
      captures: [{ variable: "bufferJobId", pointers: ["/structuredContent/jobId"] }],
    });
    expect(geoprocessing.get("wait-buffer-job")).toMatchObject({
      kind: "mcp-resource",
      uri: "honua://jobs/${bufferJobId}",
      waitFor: { equals: "Succeeded", terminal: ["Succeeded", "Failed", "Cancelled"] },
    });
    expect(geoprocessing.get("read-buffer-results")).toMatchObject({
      kind: "mcp-resource",
      uri: "honua://jobs/${bufferJobId}/results",
      captures: expect.arrayContaining([
        expect.objectContaining({
          variable: "bufferArtifactId",
          parsedPointers: ["/artifacts/0/artifactId"],
        }),
      ]),
    });
    expect(geoprocessing.get("buffer-esri-gpserver")).toMatchObject({
      kind: "gpserver",
      processId: "geometry.buffer",
      parameters: { wkb: expect.any(String), srid: 4326, distance: 0.00025 },
      captures: [{ variable: "gpServerJobId", pointers: ["/jobId"] }],
    });
    expect(geoprocessing.get("buffer-esri-gpserver")).not.toHaveProperty("parameters.layerId");
    expect(
      (geoprocessing.get("buffer-esri-gpserver") as { parameters: Record<string, unknown> }).parameters,
    ).not.toHaveProperty("layerId");

    const studio = new Map(plan.stages[4]?.actions.map((action) => [action.id, action]));
    expect([
      studio.get("create-map-draft"),
      studio.get("create-app-draft"),
      studio.get("create-dashboard-draft"),
    ]).toEqual([
      expect.objectContaining({ kind: "mcp", arguments: expect.objectContaining({ family: "map" }) }),
      expect.objectContaining({ kind: "mcp", arguments: expect.objectContaining({ family: "app" }) }),
      expect.objectContaining({ kind: "mcp", arguments: expect.objectContaining({ family: "dashboard" }) }),
    ]);
    for (const family of ["map", "app", "dashboard"] as const) {
      expect(studio.get(`save-${family}-version`)).toMatchObject({
        kind: "mcp",
        tool: "honua_studio_save_version",
        arguments: {
          draftId: `\${${family}DraftId}`,
          generation: `\${${family}Generation}`,
          changeNote: `2026.1 zero-to-map ${family}`,
        },
        captures: expect.arrayContaining([
          expect.objectContaining({
            variable: `${family}VersionId`,
            pointers: ["/structuredContent/version/versionId"],
          }),
          expect.objectContaining({
            variable: `${family}VersionNumber`,
            pointers: ["/structuredContent/version/versionNumber"],
          }),
          expect.objectContaining({
            variable: `${family}ContentHash`,
            pointers: ["/structuredContent/version/contentHash"],
          }),
        ]),
      });
      expect(studio.get(`get-${family}-version`)).toMatchObject({
        kind: "mcp",
        tool: "honua_studio_get_version",
        arguments: { itemId: `\${${family}ItemId}`, versionId: `\${${family}VersionId}` },
        captures: expect.arrayContaining([
          expect.objectContaining({ pointers: ["/structuredContent/versionId"] }),
          expect.objectContaining({ pointers: ["/structuredContent/contentHash"] }),
        ]),
      });
      expect(studio.get(`reopen-${family}-version`)).toMatchObject({
        kind: "mcp",
        tool: "honua_studio_reopen_version",
        arguments: { itemId: `\${${family}ItemId}`, versionId: `\${${family}VersionId}` },
        captures: expect.arrayContaining([
          expect.objectContaining({ variable: `${family}ReopenedDraftId` }),
          expect.objectContaining({ variable: `${family}ReopenedBaseVersionId`, equals: `\${${family}VersionId}` }),
        ]),
      });
    }
    const compositionTools = {
      map: [
        "honua_studio_add_layer",
        "honua_studio_set_layer_style",
        "honua_studio_set_view",
        "honua_studio_add_widget",
        "honua_studio_add_control",
      ],
      app: [
        "honua_studio_add_layer",
        "honua_studio_set_layer_style",
        "honua_studio_set_view",
        "honua_studio_add_widget",
        "honua_studio_add_control",
      ],
      dashboard: [
        "honua_studio_add_layer",
        "honua_studio_set_layer_style",
        "honua_studio_set_view",
        "honua_studio_add_widget",
        "honua_studio_add_control",
      ],
    } as const;
    const familyActionIds = {
      map: ["add-map-parcels-layer", "style-map-buffer-layer", "set-map-view", "add-map-widget", "add-map-control"],
      app: [
        "add-app-parcels-layer",
        "style-app-buffer-layer",
        "set-app-view",
        "add-app-chart",
        "add-app-layer-control",
      ],
      dashboard: [
        "add-dashboard-buffer-layer",
        "style-dashboard-buffer-layer",
        "set-dashboard-view",
        "add-dashboard-chart",
        "add-dashboard-layer-control",
      ],
    } as const;
    for (const family of ["map", "app", "dashboard"] as const) {
      expect(familyActionIds[family].map((id) => studio.get(id)?.tool)).toEqual(compositionTools[family]);
      for (const actionId of familyActionIds[family]) {
        expect(studio.get(actionId)).toMatchObject({
          arguments: { draftId: `\${${family}DraftId}`, generation: `\${${family}Generation}` },
          captures: [{ variable: `${family}Generation`, pointers: ["/structuredContent/generation"] }],
        });
      }
    }

    const shareUrls = ["${mapShareUrl}", "${appShareUrl}", "${dashboardShareUrl}"];
    expect(plan.stages[6]?.actions.map((action) => [action.kind, action.kind === "http" ? action.url : ""])).toEqual(
      shareUrls.map((url) => ["http", url]),
    );
    expect(plan.stages[7]?.actions.map((action) => action.id)).toEqual([
      "verify-map-public-url",
      "verify-share-url",
      "verify-dashboard-public-url",
    ]);
    expect(plan.stages[7]?.actions.map((action) => (action.kind === "http" ? action.url : ""))).toEqual(shareUrls);

    const proposal = new Map(plan.stages[5]?.actions.map((action) => [action.id, action]));
    const proposalRoutes = { map: "${mapRoute}", app: "${route}", dashboard: "${dashboardRoute}" } as const;
    for (const family of ["map", "app", "dashboard"] as const) {
      const action = proposal.get(`propose-${family}-publication`);
      expect(action).toMatchObject({
        kind: "mcp",
        tool: "honua_studio_propose_publication",
        arguments: {
          itemId: `\${${family}ItemId}`,
          versionId: `\${${family}VersionId}`,
          contentHash: `\${${family}ContentHash}`,
          route: proposalRoutes[family],
          visibility: "public",
        },
        captures: expect.arrayContaining([
          expect.objectContaining({ variable: `${family}HumanConfirmationRequired`, equals: false }),
          expect.objectContaining({ variable: `${family}ShareUrl`, pointers: ["/structuredContent/shareUrl"] }),
        ]),
      });
      expect(action && "forbiddenPointers" in action ? action.forbiddenPointers : undefined).toBeUndefined();
      expect(action?.kind === "mcp" ? action.arguments : {}).not.toHaveProperty("draftId");
      expect(action?.kind === "mcp" ? action.arguments : {}).not.toHaveProperty("generation");
      expect(action?.kind === "mcp" ? action.arguments : {}).not.toHaveProperty("embed");
      expect(proposal.has(`save-${family}-publication-version`)).toBe(false);
    }

    const admin = new Map(plan.stages[1]?.actions.map((action) => [action.id, action]));
    expect(admin.get("create-connection")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_connections_create",
      arguments: {
        secretReference: "${dbSecretReference}",
        secretType: "${dbSecretType}",
      },
      captures: [
        {
          pointers: ["/structuredContent/details/response"],
          parsedPointers: ["/data/connectionId"],
        },
      ],
    });
    expect(admin.get("create-connection")?.kind === "mcp" ? admin.get("create-connection") : undefined).toMatchObject({
      arguments: expect.not.objectContaining({ body: expect.anything(), password: expect.anything() }),
    });
    expect(admin.get("test-connection")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_connections_test",
      arguments: { id: "${connectionId}" },
    });
    expect(admin.get("publish-parcels")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_layer_publish",
      arguments: {
        connectionId: "${connectionId}",
        schema: "public",
        table: "${parcelsTable}",
        layerName: "Parcels",
      },
      captures: [
        {
          pointers: ["/structuredContent/details/response"],
          parsedPointers: ["/data/layerId"],
        },
      ],
    });
    expect(admin.get("set-public-access")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_services_access_policy_set",
      arguments: { serviceName: "${serviceName}", allowAnonymous: true, allowAnonymousWrite: false },
    });
    expect(plan.stages[1]?.actions.filter((action) => action.kind === "mcp").map((action) => action.tool)).toEqual([
      "honua_admin_server_status",
      "honua_admin_api_key_list",
      "honua_admin_api_key_effective_permissions",
      "honua_admin_connections_create",
      "honua_admin_connections_test",
      "honua_admin_import_upload_url",
      "honua_admin_import_upload_url",
      "honua_admin_layer_publish",
      "honua_admin_layer_publish",
      "honua_admin_services_access_policy_set",
    ]);
    expect(plan.stages.flatMap((stage) => stage.actions).map((action) => action.id)).not.toContain("create-scoped-key");
    expect(ADMIN_MCP_EXCLUDED_OPERATIONS.map((operation) => operation.toolName)).toContain(
      "honua_admin_api_key_create",
    );
  });

  it("honors the server PublishedOperation handle instead of guessing top-level endpoint ids", () => {
    const completed = adminOperation("admin.connection.create", { data: { connectionId: "connection-1" } }).value;
    expect(requireCompletedPublishedOperation("honua_admin_connections_create", completed)).toMatchObject({
      operationId: "admin.connection.create",
      status: "Completed",
      handleId: "handle-admin.connection.create",
    });

    const approval = value({
      operationId: "admin.layer.publish",
      status: "RequiresApproval",
      handleId: "handle-publish",
      approvalLane: "B",
    }).value;
    expect(() => requireCompletedPublishedOperation("honua_admin_layer_publish", approval)).toThrowError(
      expect.objectContaining<Partial<JourneyBlockedError>>({ code: "operation-approval-required" }),
    );
  });

  it("polls queued MCP jobs and fails immediately on a non-success terminal state", async () => {
    const action = {
      id: "wait-job",
      title: "Wait job",
      kind: "mcp-resource" as const,
      uri: "honua://jobs/job-1",
      waitFor: {
        pointer: "/status",
        equals: "Succeeded",
        terminal: ["Succeeded", "Failed", "Cancelled"],
        pollIntervalMs: 1,
        deadlineMs: 100,
      },
    };
    let reads = 0;
    const result = await readJourneyMcpResource(action, async (uri) => {
      reads += 1;
      return resourceValue(uri, { status: reads === 1 ? "Running" : "Succeeded" }).value;
    });
    expect(reads).toBe(2);
    expect(result.evidence).toMatchObject({ uri: action.uri, status: "Succeeded" });

    await expect(
      readJourneyMcpResource(action, async (uri) => resourceValue(uri, { status: "Failed" }).value),
    ).rejects.toThrow("reached terminal Failed; expected Succeeded");
  });

  it("contract mode never executes and records an explicit block plus skips", async () => {
    const plan = await loadPlan();
    const adapter = neverCalledAdapter();
    const receipt = await runZeroToMapJourney(plan, adapter, { execute: false, now: deterministicClock() });

    expect(receipt).toMatchObject({ mode: "contract", status: "blocked" });
    expect(receipt.dependencyRefs).toContain("honua-server#3304 publication status and stable URL");
    expect(receipt.blockers).toHaveLength(1);
    expect(receipt.stages[0]?.status).toBe("blocked");
    expect(receipt.stages[0]?.actions[0]).toMatchObject({
      status: "blocked",
      code: "live-execution-disabled",
    });
    expect(receipt.stages.slice(1).every((stage) => stage.status === "skipped")).toBe(true);
  });

  it("bounds local Docker fixtures without weakening the AWS public HTTPS boundary", async () => {
    const plan = await loadPlan();
    const adapter = neverCalledAdapter();
    const local = await runZeroToMapJourney(plan, adapter, {
      execute: false,
      target: "local-docker",
      variables: { fixtureBaseUrl: "http://host.docker.internal:4173/" },
      now: deterministicClock(),
    });
    expect(local.status).toBe("blocked");

    await expect(
      runZeroToMapJourney(plan, adapter, {
        execute: false,
        target: "aws-ecs",
        variables: { fixtureBaseUrl: "http://host.docker.internal:4173" },
      }),
    ).rejects.toThrow("public HTTPS");

    for (const fixtureBaseUrl of [
      "http://host.docker.internal:4174",
      "http://fixtures.local:4173",
      "http://user:password@host.docker.internal:4173",
      "http://host.docker.internal:4173?credential=unexpected",
    ]) {
      await expect(
        runZeroToMapJourney(plan, adapter, {
          execute: false,
          target: "local-docker",
          variables: { fixtureBaseUrl },
        }),
      ).rejects.toThrow("local Docker fixture origin");
    }
  });

  it("preflights the complete MCP catalog before the first server mutation", async () => {
    const plan = await loadPlan();
    const calls: string[] = [];
    const adapter: JourneyAdapter = {
      async runCli(args) {
        calls.push(`cli:${args.join(" ")}`);
        return cliResult(args);
      },
      async listTools() {
        calls.push("tools/list");
        return [];
      },
      async callTool(tool) {
        calls.push(`tools/call:${tool}`);
        return {};
      },
      async readImageResource() {
        throw new Error("this journey must not fetch rendered image artifacts");
      },
      async readResource() {
        return {};
      },
      async runGpServer() {
        calls.push("gpserver");
        return {};
      },
      async readReceipt() {
        return undefined;
      },
      async checkHttp() {
        return {};
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, {
      execute: true,
      now: deterministicClock(),
    });

    expect(receipt.status).toBe("blocked");
    expect(receipt.stages[1]?.actions[0]).toMatchObject({ status: "blocked", code: "mcp-catalog-incomplete" });
    expect(calls.filter((call) => call.startsWith("tools/call"))).toEqual([]);
    expect(calls).toEqual([
      "cli:admin install local --profile gp-dev --yes --directory .honua-zero-to-map",
      "cli:admin install status --directory .honua-zero-to-map",
      "tools/list",
    ]);
  });

  it("accepts tools beyond the closed roster instead of requiring a 441-tool catalog", async () => {
    const plan = await loadPlan();
    const requiredTools = zeroToMapClosedRoster(plan);
    let mutationCalled = false;
    const adapter: JourneyAdapter = {
      async runCli(args) {
        return cliResult(args);
      },
      async listTools() {
        return [...completeCatalog(requiredTools), { name: "honua_unexpected_extra", inputSchema: { type: "object" } }];
      },
      async callTool() {
        mutationCalled = true;
        throw new Error("closed-roster preflight allowed the first call");
      },
      async readImageResource() {
        throw new Error("this journey must not fetch rendered image artifacts");
      },
      async readResource() {
        return {};
      },
      async runGpServer() {
        return {};
      },
      async readReceipt() {
        return undefined;
      },
      async checkHttp() {
        return {};
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, { execute: true, now: deterministicClock() });
    expect(receipt.status).toBe("failed");
    expect(receipt.stages[1]?.actions[0]?.code).not.toBe("mcp-catalog-incomplete");
    expect(mutationCalled).toBe(true);
    expect(receipt.catalog?.activeProfiles).toEqual([ZERO_TO_MAP_CLOSED_ROSTER_ID]);
    expect(receipt.catalog?.expectedTotalTools).toBe(requiredTools.length);
    expect(receipt.catalog?.advertisedTotalTools).toBe(requiredTools.length + 1);
  });

  it("asserts the closed roster this journey calls, not a profile total", async () => {
    const plan = await loadPlan();
    const roster = zeroToMapClosedRoster(plan);
    expect(roster).toEqual(
      [
        ...new Set(
          plan.stages.flatMap((stage) =>
            stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
          ),
        ),
      ].sort(),
    );
    expect(roster).toEqual(
      expect.arrayContaining([
        "honua_admin_connections_create",
        "honua_admin_connections_test",
        "honua_admin_services_access_policy_set",
        "honua_validate_plan",
        "honua_execute_plan",
        "honua_studio_propose_publication",
      ]),
    );
    expect(roster).not.toEqual(expect.arrayContaining(["honua_esri_gp_list_tasks", "honua_buffer_features"]));
    expect(roster.length).toBeLessThan(100);
  });

  it("names the missing closed-roster tool, its stage and its action", async () => {
    const plan = await loadPlan();
    const receipt = await runZeroToMapJourney(plan, catalogAdapter([]), {
      execute: true,
      now: deterministicClock(),
    });

    expect(receipt.status).toBe("blocked");
    const action = receipt.stages[1]?.actions[0];
    expect(action).toMatchObject({ status: "blocked", code: "mcp-catalog-incomplete" });
    expect(action?.message).toContain("honua_validate_plan (stage 4 geoprocessing, action validate-buffer-plan)");
    expect(action?.message).toContain("honua_execute_plan (stage 4 geoprocessing, action execute-buffer-plan)");
    expect(action?.message).not.toContain("esri-gp");
    expect(action?.message).not.toContain("441");
    expect(receipt.catalog).toBeUndefined();
  });

  it("names a missing closed-roster member instead of a shortfall from a catalog total", async () => {
    const plan = await loadPlan();
    const truncated = completeCatalog(zeroToMapClosedRoster(plan)).slice(0, -3);

    const receipt = await runZeroToMapJourney(plan, catalogAdapter(truncated), {
      execute: true,
      now: deterministicClock(),
    });

    const action = receipt.stages[1]?.actions[0];
    expect(action).toMatchObject({ status: "blocked", code: "mcp-catalog-incomplete" });
    expect(action?.message).toContain(`the ${ZERO_TO_MAP_CLOSED_ROSTER_ID} roster is not advertised`);
    expect(action?.message).not.toContain("truncated:");
    expect(action?.message).not.toContain("441");
  });

  it("reports a duplicate catalog member without treating extra tools as a roster fault", async () => {
    const plan = await loadPlan();
    const catalog = completeCatalog(zeroToMapClosedRoster(plan));
    const drifted = [...catalog, { name: catalog[0]?.name as string, inputSchema: { type: "object" } }];

    const receipt = await runZeroToMapJourney(plan, catalogAdapter(drifted), {
      execute: true,
      now: deterministicClock(),
    });

    const action = receipt.stages[1]?.actions[0];
    expect(action).toMatchObject({ status: "blocked", code: "mcp-catalog-incomplete" });
    expect(action?.message).toContain(`duplicate: the catalog advertises ${catalog[0]?.name} more than once`);
    expect(action?.message).not.toContain("unexpected:");
    expect(action?.message).not.toContain("excluded:");
  });

  it("records the closed roster and its digest on the receipt", async () => {
    const plan = await loadPlan();
    const roster = zeroToMapClosedRoster(plan);
    const catalog = completeCatalog(roster);
    const adapter: JourneyAdapter = {
      ...catalogAdapter(catalog),
      async callTool(tool) {
        throw new Error(`stopping the journey after the catalog preflight at ${tool}`);
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, { execute: true, now: deterministicClock() });

    expect(receipt.status).toBe("failed");
    const adminCount = roster.filter((name) => name.startsWith("honua_admin_")).length;
    expect(receipt.catalog).toMatchObject({
      schemaVersion: "honua.zero-to-map.catalog/v1",
      activeProfiles: [ZERO_TO_MAP_CLOSED_ROSTER_ID],
      expectedTotalTools: roster.length,
      advertisedTotalTools: roster.length,
      baseStaticTools: roster.length - adminCount,
      baseAdminTools: adminCount,
      auditedExclusions: 0,
    });
    expect(receipt.catalog?.profiles.map((profile) => [profile.id, profile.advertisedMembers])).toEqual([
      [ZERO_TO_MAP_CLOSED_ROSTER_ID, roster.length],
    ]);
    expect(receipt.catalog?.profiles[0]?.confirmedMembers).toEqual(roster);
    for (const digest of [
      receipt.catalog?.catalogSha256,
      receipt.catalog?.adminRosterSha256,
      receipt.catalog?.staticRosterSha256,
      ...(receipt.catalog?.profiles ?? []).map((profile) => profile.rosterSha256),
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(receipt.catalog?.adminRosterSha256).not.toBe(receipt.catalog?.staticRosterSha256);
  });

  it("fails closed before mutation until the exact Studio version lifecycle tools are advertised", async () => {
    const plan = await loadPlan();
    const requiredTools = [
      ...new Set(
        plan.stages.flatMap((stage) =>
          stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
        ),
      ),
    ];
    const unavailable = new Set([
      "honua_studio_save_version",
      "honua_studio_get_version",
      "honua_studio_reopen_version",
    ]);
    const calls: string[] = [];
    const adapter: JourneyAdapter = {
      async runCli(args) {
        calls.push(`cli:${args.join(" ")}`);
        return cliResult(args);
      },
      async listTools() {
        calls.push("tools/list");
        return completeCatalog(requiredTools.filter((name) => !unavailable.has(name)));
      },
      async callTool(tool) {
        calls.push(`tools/call:${tool}`);
        return {};
      },
      async readImageResource() {
        throw new Error("this journey must not fetch rendered image artifacts");
      },
      async readResource() {
        return {};
      },
      async runGpServer() {
        return {};
      },
      async readReceipt() {
        return undefined;
      },
      async checkHttp() {
        return {};
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, { execute: true, now: deterministicClock() });

    expect(receipt.status).toBe("blocked");
    expect(receipt.stages[1]?.actions[0]).toMatchObject({
      status: "blocked",
      code: "mcp-catalog-incomplete",
    });
    expect(receipt.stages[1]?.actions[0]?.message).toContain(
      "honua_studio_save_version (stage 5 studio, action save-map-version)",
    );
    expect(receipt.stages[1]?.actions[0]?.message).toContain(
      "honua_studio_get_version (stage 5 studio, action get-map-version)",
    );
    expect(receipt.stages[1]?.actions[0]?.message).toContain(
      "honua_studio_reopen_version (stage 5 studio, action reopen-map-version)",
    );
    expect(calls.filter((call) => call.startsWith("tools/call"))).toEqual([]);
  });

  it("fails closed when a published admin input schema drifts", async () => {
    const plan = await loadPlan();
    const requiredTools = [
      ...new Set(
        plan.stages.flatMap((stage) =>
          stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
        ),
      ),
    ];
    const calls: string[] = [];
    const adapter: JourneyAdapter = {
      async runCli(args) {
        return cliResult(args);
      },
      async listTools() {
        return completeCatalog(requiredTools, (name) =>
          name === "honua_admin_connections_create"
            ? {
                type: "object",
                additionalProperties: false,
                required: ["body"],
                properties: { body: { type: "string" } },
              }
            : { type: "object" },
        );
      },
      async callTool(tool) {
        calls.push(tool);
        return {};
      },
      async readImageResource() {
        throw new Error("this journey must not fetch rendered image artifacts");
      },
      async readResource() {
        return {};
      },
      async runGpServer() {
        return {};
      },
      async readReceipt() {
        return undefined;
      },
      async checkHttp() {
        return {};
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, { execute: true, now: deterministicClock() });
    expect(receipt.status).toBe("blocked");
    expect(receipt.stages[1]?.actions[0]).toMatchObject({
      status: "blocked",
      code: "mcp-input-contract-mismatch",
    });
    expect(calls).toEqual([]);
  });

  it("resolves a root-relative share URL on the MCP origin and refuses public HTTP", () => {
    expect(resolvePublishedShareUrl("/api/v1/studio/published/zero-to-map", "http://127.0.0.1:8080/mcp")).toBe(
      "http://127.0.0.1:8080/api/v1/studio/published/zero-to-map",
    );
    expect(resolvePublishedShareUrl("https://candidate.example.test/api/v1/studio/published/zero-to-map")).toBe(
      "https://candidate.example.test/api/v1/studio/published/zero-to-map",
    );
    expect(() => resolvePublishedShareUrl("http://candidate.example.test/map")).toThrow(/HTTPS/);
    expect(() => resolvePublishedShareUrl("/api/v1/studio/published/zero-to-map")).toThrow(/MCP endpoint/);
  });

  it("publishes with one admin credential and fetches the share URLs", async () => {
    const plan = await loadPlan();
    const requiredTools = zeroToMapClosedRoster(plan);
    const seenArguments = new Map<string, Readonly<Record<string, unknown>>>();
    const resourceUris: string[] = [];
    const publicUrls: string[] = [];
    let receiptReads = 0;
    const studio = {
      map: {
        draftId: "11111111-1111-4111-8111-111111111111",
        itemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        reopenedDraftId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        contentHash: "sha256:map",
        route: "zero-to-map-map",
      },
      app: {
        draftId: "22222222-2222-4222-8222-222222222222",
        itemId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        reopenedDraftId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        contentHash: "sha256:app",
        route: "zero-to-map",
      },
      dashboard: {
        draftId: "33333333-3333-4333-8333-333333333333",
        itemId: "44444444-4444-4444-8444-444444444444",
        versionId: "55555555-5555-4555-8555-555555555555",
        reopenedDraftId: "66666666-6666-4666-8666-666666666666",
        contentHash: "sha256:dashboard",
        route: "zero-to-map-dashboard",
      },
    } as const;
    const generations = new Map<string, number>();
    let layerId = 0;
    const adapter: JourneyAdapter = {
      async runCli(args) {
        return cliResult(args);
      },
      async listTools() {
        return completeCatalog(requiredTools);
      },
      async callTool(tool, args) {
        seenArguments.set(tool, args);
        if (tool === "honua_admin_api_key_list") {
          return adminOperation("admin.api-key.list", {
            data: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                status: "active",
                permissions: ["admin:read", "admin:write"],
              },
            ],
          });
        }
        if (tool === "honua_admin_api_key_effective_permissions") {
          return adminOperation("admin.api-key.effective-permissions", {
            data: {
              id: "11111111-1111-4111-8111-111111111111",
              status: "active",
              canAuthenticate: true,
              permissions: ["admin:read", "admin:write"],
            },
          });
        }
        if (tool === "honua_admin_connections_create") {
          return adminOperation("admin.connections.create", { data: { connectionId: "connection-1" } });
        }
        if (tool === "honua_admin_layer_publish") {
          layerId += 1;
          return adminOperation("admin.layer.publish", { data: { layerId } });
        }
        if (tool === "honua_get_style") {
          return Object.keys(args).length === 0
            ? value({ styles: [{ styleId: "style_canonical" }] })
            : value({ styleId: "style_canonical", styleVersion: args.includeStylesheet === true ? 1 : 3 });
        }
        if (tool === "honua_apply_style_preset") {
          return value({ styleId: "style_canonical", styleVersion: 3, applied: true });
        }
        if (tool === "honua_render_map") {
          return value({
            layers: [{ styleId: "style_canonical" }],
            image: { width: 512, height: 512, uri: "honua://renders/zero-to-map-parcels.png" },
          });
        }
        if (tool === "honua_validate_plan" || tool === "honua_execute_plan") {
          return value(tool === "honua_execute_plan" ? { jobId: "buffer-job-1", status: "queued" } : { valid: true });
        }
        if (tool === "honua_studio_create_draft") {
          const identity = studio[args.family as keyof typeof studio];
          generations.set(identity.draftId, 1);
          return value({ draftId: identity.draftId, itemId: identity.itemId, generation: 1 });
        }
        if (tool === "honua_studio_save_version") {
          const identity = Object.values(studio).find((candidate) => candidate.draftId === args.draftId);
          if (!identity) throw new Error(`unknown Studio draft ${String(args.draftId)}`);
          return value({
            version: {
              itemId: identity.itemId,
              versionId: identity.versionId,
              versionNumber: 1,
              contentHash: identity.contentHash,
            },
          });
        }
        if (tool === "honua_studio_get_version") {
          const identity = Object.values(studio).find((candidate) => candidate.itemId === args.itemId);
          if (!identity) throw new Error(`unknown Studio item ${String(args.itemId)}`);
          return value({ versionId: identity.versionId, contentHash: identity.contentHash });
        }
        if (tool === "honua_studio_reopen_version") {
          const identity = Object.values(studio).find((candidate) => candidate.itemId === args.itemId);
          if (!identity) throw new Error(`unknown Studio item ${String(args.itemId)}`);
          generations.set(identity.reopenedDraftId, 1);
          return value({
            draftId: identity.reopenedDraftId,
            itemId: identity.itemId,
            baseVersionId: identity.versionId,
            generation: 1,
          });
        }
        if (tool === "honua_studio_propose_publication") {
          const identity = Object.values(studio).find((candidate) => candidate.itemId === args.itemId);
          if (!identity) throw new Error(`unknown Studio item ${String(args.itemId)}`);
          return value({
            humanConfirmationRequired: false,
            shareUrl: `https://candidate.example.test/api/v1/studio/published/${identity.route}`,
          });
        }
        if (tool.startsWith("honua_studio_") && tool !== "honua_studio_validate_draft") {
          const draftId = String(args.draftId);
          const generation = (generations.get(draftId) ?? 0) + 1;
          generations.set(draftId, generation);
          return value({ draftId, generation });
        }
        return tool === "honua_studio_validate_draft" ? value({ status: "valid" }) : value({ ok: true });
      },
      async readImageResource(_action, expected) {
        return {
          value: { contents: [{ uri: expected.uri }] },
          evidence: assertRenderedPng(pngFixture(512, 512), "image/png", expected),
        };
      },
      async readResource(action) {
        resourceUris.push(action.uri);
        if (action.uri.endsWith("/results")) {
          return resourceValue(action.uri, {
            jobId: "buffer-job-1",
            artifacts: [{ artifactId: "artifact-buffer-1", kind: "FeatureLayer" }],
          });
        }
        return resourceValue(action.uri, { jobId: "buffer-job-1", status: "Succeeded" });
      },
      async runGpServer(action) {
        expect(action.processId).toBe("geometry.buffer");
        expect(action.parameters).toMatchObject({ wkb: expect.any(String), srid: 4326 });
        expect(action.parameters).not.toHaveProperty("layerId");
        return { value: { jobId: "gp-buffer-1", status: "successful" }, evidence: { protocol: "geoservices-gp" } };
      },
      async readReceipt() {
        receiptReads += 1;
        throw new Error("the operator journey must not import a console receipt");
      },
      async checkHttp(url, expectedStatus) {
        expect(expectedStatus).toBe(200);
        publicUrls.push(url);
        return { evidence: { status: 200 } };
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, {
      execute: true,
      now: deterministicClock(),
      variables: {
        dbPassword: "not-recorded",
        fixtureBaseUrl: "https://fixtures.example.test",
        candidateId: "candidate-1",
        releaseId: "release-1",
      },
    });

    expect(receipt.status, JSON.stringify(receipt.blockers, null, 2)).toBe("passed");
    expect(receiptReads).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("not-recorded");
    expect(seenArguments.get("honua_admin_connections_create")).toMatchObject({
      secretReference: "env:HONUA_ZERO_TO_MAP_DB_CONNECTION",
      secretType: "environment",
    });
    expect(seenArguments.get("honua_admin_connections_create")).not.toHaveProperty("body");
    expect(seenArguments.get("honua_admin_connections_test")).toEqual({ id: "connection-1" });
    expect(seenArguments.get("honua_admin_layer_publish")).toMatchObject({
      connectionId: "connection-1",
      schema: "public",
      table: "zero_to_map_zoning",
      layerName: "Zoning",
    });
    expect(seenArguments.get("honua_admin_services_access_policy_set")).toEqual({
      serviceName: "zero-to-map",
      allowAnonymous: true,
      allowAnonymousWrite: false,
    });
    expect(seenArguments.get("honua_execute_plan")).toMatchObject({
      plan: {
        steps: [{ processId: "analytics.buffer-aggregate", inputs: { layerId: 1, distance: "25", unit: "meters" } }],
      },
    });
    expect(resourceUris).toEqual(["honua://jobs/buffer-job-1", "honua://jobs/buffer-job-1/results"]);
    expect(seenArguments.get("honua_studio_add_layer")).toMatchObject({
      layer: { sourceId: "honua://artifacts/artifact-buffer-1" },
    });
    expect(seenArguments.get("honua_studio_propose_publication")).toEqual({
      itemId: studio.dashboard.itemId,
      versionId: studio.dashboard.versionId,
      contentHash: studio.dashboard.contentHash,
      route: "zero-to-map-dashboard",
      visibility: "public",
      note: "2026.1 D9.3 zero-to-map dashboard candidate",
    });
    const shareUrls = [
      "https://candidate.example.test/api/v1/studio/published/zero-to-map-map",
      "https://candidate.example.test/api/v1/studio/published/zero-to-map",
      "https://candidate.example.test/api/v1/studio/published/zero-to-map-dashboard",
    ];
    expect(publicUrls).toEqual([...shareUrls, ...shareUrls]);
  });

  it("plans the canonical published-layer style and render proof", async () => {
    const plan = await loadPlan();
    const stage = plan.stages[2];
    expect(stage).toMatchObject({ number: 3, id: "style" });
    expect(stage?.actions.map((action) => action.id)).toEqual([
      "read-published-style",
      "list-style-presets",
      "apply-canonical-style",
      "confirm-published-style",
      "render-published-map",
      "read-rendered-map",
    ]);

    const actions = new Map(stage?.actions.map((action) => [action.id, action]));
    // The preset is discovered from the candidate's own published style catalog
    // rather than named here, and the same discovered identity is then required
    // of the apply result, the read-back and the render.
    expect(actions.get("apply-canonical-style")).toMatchObject({
      kind: "mcp",
      tool: "honua_apply_style_preset",
      arguments: { serviceId: "${serviceName}", styleId: "${discoveredStylePresetId}" },
      captures: expect.arrayContaining([
        expect.objectContaining({ variable: "appliedStyleId", equals: "${discoveredStylePresetId}" }),
        expect.objectContaining({ variable: "styleApplied", equals: true }),
      ]),
    });
    expect(actions.get("confirm-published-style")).toMatchObject({
      kind: "mcp",
      tool: "honua_get_style",
      captures: expect.arrayContaining([
        expect.objectContaining({ variable: "confirmedStyleId", equals: "${discoveredStylePresetId}" }),
        expect.objectContaining({ variable: "confirmedStyleVersion", equals: "${appliedStyleVersion}" }),
      ]),
    });
    expect(actions.get("render-published-map")).toMatchObject({
      kind: "mcp",
      tool: "honua_render_map",
      captures: expect.arrayContaining([
        expect.objectContaining({ variable: "renderedStyleId", equals: "${discoveredStylePresetId}" }),
      ]),
    });
    // The render must frame the ground the fixtures actually occupy. A bbox
    // pointing anywhere else yields a valid, correctly sized, empty PNG - which
    // is precisely the outcome the artifact judgment exists to refuse.
    const render = actions.get("render-published-map") as { arguments: { bbox: number[] } };
    const parcels = JSON.parse(await readFile(`${bundleRoot}/fixtures/parcels.geojson`, "utf8")) as {
      features: { geometry: { coordinates: unknown } }[];
    };
    const xs: number[] = [];
    const ys: number[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node) && typeof node[0] === "number" && typeof node[1] === "number") {
        xs.push(node[0]);
        ys.push(node[1]);
        return;
      }
      if (Array.isArray(node)) for (const child of node) walk(child);
    };
    for (const feature of parcels.features) walk(feature.geometry.coordinates);
    const [minX, minY, maxX, maxY] = render.arguments.bbox as [number, number, number, number];
    expect(minX).toBeLessThanOrEqual(Math.min(...xs));
    expect(minY).toBeLessThanOrEqual(Math.min(...ys));
    expect(maxX).toBeGreaterThanOrEqual(Math.max(...xs));
    expect(maxY).toBeGreaterThanOrEqual(Math.max(...ys));
    // ...and the same extent the Studio stage frames, so the two never drift.
    const studioView = plan.stages[4]?.actions.find((action) => action.id === "set-map-view") as {
      arguments: { view: { bbox: number[] } };
    };
    expect(render.arguments.bbox).toEqual(studioView.arguments.view.bbox);

    expect(actions.get("read-rendered-map")).toMatchObject({
      kind: "mcp-image",
      uri: "${renderImageUri}",
      expectedMediaType: "image/png",
      expectedWidth: "${renderWidth}",
      expectedHeight: "${renderHeight}",
    });
  });

  it("selects the full-catalog view so a configured workflow view cannot narrow the preflight roster", async () => {
    const plan = await loadPlan();
    const requestedViews: (string | undefined)[] = [];
    const adapter = blockedCatalogAdapter([]);
    const receipt = await runZeroToMapJourney(
      plan,
      {
        ...adapter,
        async listTools(options) {
          requestedViews.push(options?.view);
          return [];
        },
      },
      { execute: true, now: deterministicClock() },
    );

    expect(receipt.status).toBe("blocked");
    expect(requestedViews).toEqual([ZERO_TO_MAP_FULL_CATALOG_VIEW]);
    expect(receipt.stages[1]?.actions[0]?.message).toContain(ZERO_TO_MAP_WORKFLOW_VIEW_CONFIG_KEY);
    expect(receipt.stages[1]?.actions[0]?.message).toContain(ZERO_TO_MAP_WORKFLOW_VIEW_ENV_KEY);
  });

  it("records the full-catalog view on the catalog receipt", async () => {
    const plan = await loadPlan();
    const requiredTools = plan.stages.flatMap((stage) =>
      stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
    );
    const adapter = blockedCatalogAdapter(completeCatalog(requiredTools));
    const receipt = await runZeroToMapJourney(
      plan,
      {
        ...adapter,
        async callTool() {
          throw new Error("stop after the preflight");
        },
      },
      { execute: true, now: deterministicClock() },
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.catalog?.requestedView).toBe(ZERO_TO_MAP_FULL_CATALOG_VIEW);
  });

  it("accepts a rendered PNG that matches the reported geometry and carries pixel data", () => {
    const evidence = assertRenderedPng(pngFixture(512, 512), "image/png", {
      uri: "honua://renders/parcels.png",
      mediaType: "image/png",
      width: 512,
      height: 512,
      minByteLength: 1024,
    });
    expect(evidence).toMatchObject({ width: 512, height: 512, mediaType: "image/png" });
    expect(evidence.imageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the artifact when a render no-op returns something that is not a drawn map", () => {
    const expected = {
      uri: "honua://renders/parcels.png",
      mediaType: "image/png",
      width: 512,
      height: 512,
      minByteLength: 1024,
    };
    expect(() => assertRenderedPng(pngFixture(512, 512, { idat: false }), "image/png", expected)).toThrow(
      /honua:\/\/renders\/parcels\.png carries no IDAT pixel data/,
    );
    expect(() => assertRenderedPng(pngFixture(256, 256), "image/png", expected)).toThrow(
      /is 256x256; the renderer reported 512x512/,
    );
    expect(() => assertRenderedPng(pngFixture(512, 512), undefined, expected)).toThrow(
      /declared media type undefined; expected image\/png/,
    );
    expect(() => assertRenderedPng(pngFixture(512, 512), "application/json", expected)).toThrow(
      /declared media type application\/json; expected image\/png/,
    );
    expect(() => assertRenderedPng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), "image/png", expected)).toThrow(
      /is not a PNG: the 8-byte PNG signature is absent/,
    );
    expect(() =>
      assertRenderedPng(pngFixture(512, 512), "image/png", { ...expected, minByteLength: 10_000_000 }),
    ).toThrow(/a style\/render no-op returns/);
  });

  it("refuses an artifact no PNG decoder could render", () => {
    const expected = {
      uri: "honua://renders/parcels.png",
      mediaType: "image/png",
      width: 64,
      height: 64,
      minByteLength: 32,
    };
    // Structural plausibility is not decodability. Each of these is a blob that
    // a chunk-counting check would wave through.
    expect(() => assertRenderedPng(pngFixture(64, 64, { corruptIdat: true }), "image/png", expected)).toThrow(
      /IDAT stream that does not inflate/,
    );
    expect(() => assertRenderedPng(pngFixture(64, 64, { badCrc: true }), "image/png", expected)).toThrow(
      /fails its IHDR chunk CRC/,
    );
    expect(() => assertRenderedPng(pngFixture(64, 64, { iend: false }), "image/png", expected)).toThrow(
      /never terminates in an IEND chunk/,
    );
  });

  it("refuses a correctly sized render that decodes to a single flat colour", () => {
    // The residual gap a bbox fix alone would leave: a valid, decodable,
    // right-sized PNG of nothing but background.
    expect(() =>
      assertRenderedPng(pngFixture(64, 64, { flat: true }), "image/png", {
        uri: "honua://renders/parcels.png",
        mediaType: "image/png",
        width: 64,
        height: 64,
        minByteLength: 32,
      }),
    ).toThrow(/decodes to a single flat colour/);
  });

  it.each([false, true])("checks visible pixels on a real PNG, Adam7=%s", (interlace) => {
    const expected = {
      uri: "honua://renders/parcels.png",
      mediaType: "image/png",
      width: 9,
      height: 7,
      minByteLength: 32,
    };
    const evidence = assertRenderedPng(pngFixture(9, 7, { interlace }), "image/png", expected);
    // The fixture explicitly paints all 9 * 7 pixels opaque, including each
    // reduced Adam7 pass. This expectation is not derived from decoder output.
    expect(evidence).toMatchObject({ width: 9, height: 7, visiblePixelCount: 63 });
    const expectedPixels = Buffer.alloc(9 * 7 * 8);
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const shade = (y * 7 + x * 13) % 256;
        const rgba = [shade, (shade * 3) % 256, (shade * 5) % 256, 255];
        rgba.forEach((sample, channel) => expectedPixels.writeUInt16BE(sample * 257, (y * 9 + x) * 8 + channel * 2));
      }
    }
    expect(evidence.decodedPixelSha256).toBe(createHash("sha256").update(expectedPixels).digest("hex"));
    expect(() => assertRenderedPng(pngFixture(9, 7, { interlace, flat: true }), "image/png", expected)).toThrow(
      /single flat colour/,
    );
    expect(() => assertRenderedPng(pngFixture(9, 7, { interlace, transparent: true }), "image/png", expected)).toThrow(
      /no visible pixels/,
    );
  });

  it("names the stage, action and tool when a style application is a silent no-op", async () => {
    const plan = await loadPlan();
    const receipt = await runZeroToMapJourney(styleStagePlan(plan), styleNoOpAdapter(plan), {
      execute: true,
      now: deterministicClock(),
      variables: { parcelsLayerId: 0 },
    });

    expect(receipt.status).toBe("failed");
    const failure = receipt.stages[2]?.actions.find((action) => action.status === "failed");
    expect(failure?.id).toBe("apply-canonical-style");
    expect(failure?.message).toContain("stage 3 style");
    expect(failure?.message).toContain("apply-canonical-style");
    expect(failure?.message).toContain("honua_apply_style_preset");
    expect(failure?.message).toContain("styleApplied");
  });
});

/**
 * A minimal but structurally real PNG: signature, IHDR carrying the requested
 * geometry, an IDAT chunk padded past the journey's byte floor unless the
 * caller asks for the degenerate no-IDAT form, and IEND.
 */
function pngFixture(
  width: number,
  height: number,
  options: {
    /** Omit the IDAT chunk entirely. */
    idat?: boolean;
    /** Emit an IDAT whose payload is not a valid deflate stream. */
    corruptIdat?: boolean;
    /** Write a deliberately wrong CRC on every chunk. */
    badCrc?: boolean;
    /** Stop before IEND. */
    iend?: boolean;
    /** Paint every pixel the same colour. */
    flat?: boolean;
    interlace?: boolean;
    transparent?: boolean;
  } = {},
): Uint8Array {
  // A real PNG: correct chunk CRCs, a genuine deflate stream, and by default a
  // raster with more than one colour in it. The validator decodes what it is
  // given, so a fixture that only looked like a PNG would prove nothing.
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const push = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(options.badCrc === true ? 0 : crc32Fixture(typed));
    parts.push(length, typed, crc);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[12] = options.interlace ? 1 : 0;
  push("IHDR", ihdr);

  if (options.idat !== false) {
    // Encode the seven passes by assigning each source coordinate its first
    // Adam7 visit. The production decoder instead computes pass dimensions.
    const passes = options.interlace ? 7 : 1;
    const scanlines: Buffer[] = [];
    for (let pass = 0; pass < passes; pass += 1) {
      for (let row = 0; row < height; row += 1) {
        const pixels: number[] = [];
        for (let column = 0; column < width; column += 1) {
          const visit =
            row % 8 === 0 && column % 8 === 0
              ? 0
              : row % 8 === 0 && column % 8 === 4
                ? 1
                : row % 8 === 4 && column % 4 === 0
                  ? 2
                  : row % 4 === 0 && column % 4 === 2
                    ? 3
                    : row % 4 === 2 && column % 2 === 0
                      ? 4
                      : row % 2 === 0 && column % 2 === 1
                        ? 5
                        : 6;
          if (options.interlace && visit !== pass) continue;
          const shade = options.flat ? 0x20 : (row * 7 + column * 13) % 256;
          pixels.push(
            shade,
            options.flat ? 0x20 : (shade * 3) % 256,
            options.flat ? 0x20 : (shade * 5) % 256,
            options.transparent ? 0 : 255,
          );
        }
        if (pixels.length) scanlines.push(Buffer.from([0, ...pixels]));
      }
    }
    const raster = Buffer.concat(scanlines);
    push("IDAT", options.corruptIdat === true ? Buffer.from("not a deflate stream at all") : deflateSync(raster));
  }

  if (options.iend !== false) push("IEND", Buffer.alloc(0));
  return new Uint8Array(Buffer.concat(parts));
}

/** PNG chunk CRC-32, independently implemented so the fixture does not borrow the validator's. */
function crc32Fixture(bytes: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function value(structuredContent: unknown): JourneyExecutionResult {
  return { value: { structuredContent } };
}

function resourceValue(uri: string, body: unknown): JourneyExecutionResult {
  return { value: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] } };
}

function adminOperation(operationId: string, response: unknown): JourneyExecutionResult {
  return value({
    operationId,
    status: "Completed",
    handleId: `handle-${operationId}`,
    details: { response: JSON.stringify(response), httpStatus: "200", responseTruncated: "False" },
  });
}

function cliResult(args: readonly string[]): JourneyExecutionResult {
  if (args[0] !== "admin" || args[1] !== "install" || args[2] !== "local") {
    return { evidence: { exitCode: 0 } };
  }
  const accessCredential = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "honua-local-agent",
    status: "active",
    requestedGrants: ["admin:read", "admin:write"],
    effectiveGrants: ["admin:read", "admin:write"],
    canAuthenticate: true,
    referenceType: "private-env-file",
    referenceDigestSha256: "a".repeat(64),
    provisioned: true,
  } as const;
  return { value: { accessCredential }, evidence: { exitCode: 0, accessCredential } };
}

/** An adapter whose catalog is `tools` and which refuses every later call. */
function blockedCatalogAdapter(
  tools: readonly { name: string; inputSchema: Record<string, unknown> }[],
): JourneyAdapter {
  const fail = () => Promise.reject(new Error("a blocked catalog preflight must not reach this adapter call"));
  return {
    async runCli(args) {
      return cliResult(args);
    },
    async listTools() {
      return tools;
    },
    callTool: fail,
    readResource: fail,
    readImageResource: fail,
    runGpServer: fail,
    async readReceipt() {
      return undefined;
    },
    checkHttp: fail,
  };
}

/**
 * The real plan with the install and admin stages reduced to trivial passing
 * CLI steps, so the style stage can be exercised on its own without replaying
 * ten admin mutations. Stage count, ids and the style stage itself are the
 * shipped ones.
 */
function styleStagePlan(plan: Awaited<ReturnType<typeof loadPlan>>) {
  const stub = (number: number, id: string, title: string) => ({
    number,
    id,
    title,
    actions: [{ id: `${id}-stub`, title: `${title} stub`, kind: "cli" as const, args: ["noop", id] }],
  });
  return {
    ...plan,
    stages: [stub(1, "install", "Install"), stub(2, "admin", "Admin"), ...plan.stages.slice(2)],
  };
}

/**
 * A candidate that answers every style call successfully except that the preset
 * application reports `applied: false` - the exact silent no-op the render proof
 * exists to catch.
 */
function styleNoOpAdapter(plan: Awaited<ReturnType<typeof loadPlan>>): JourneyAdapter {
  const requiredTools = plan.stages.flatMap((stage) =>
    stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
  );
  const fail = () => Promise.reject(new Error("the style no-op must stop the journey before this call"));
  return {
    async runCli() {
      return { value: {} };
    },
    async listTools() {
      return completeCatalog(requiredTools);
    },
    async callTool(tool) {
      if (tool === "honua_get_style") {
        return value({ styleId: "style_canonical", styleVersion: 2, styles: [{ styleId: "style_canonical" }] });
      }
      if (tool === "honua_apply_style_preset") {
        return value({
          serviceId: "zero-to-map",
          layerId: 0,
          styleId: "style_canonical",
          styleVersion: 2,
          applied: false,
        });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    readResource: fail,
    readImageResource: fail,
    runGpServer: fail,
    async readReceipt() {
      return undefined;
    },
    checkHttp: fail,
  };
}

function neverCalledAdapter(): JourneyAdapter {
  const fail = () => Promise.reject(new Error("adapter was unexpectedly called"));
  return {
    runCli: fail,
    listTools: fail,
    callTool: fail,
    readResource: fail,
    readImageResource: fail,
    runGpServer: fail,
    readReceipt: fail,
    checkHttp: fail,
  };
}

/** Minimal adapter that only serves the CLI install stage and one catalog read. */
function catalogAdapter(
  tools: readonly { name: string; inputSchema: Readonly<Record<string, unknown>> }[],
): JourneyAdapter {
  return {
    async runCli(args) {
      return cliResult(args);
    },
    async listTools() {
      return tools;
    },
    async callTool() {
      throw new Error("a blocked catalog preflight must not reach tools/call");
    },
    async readImageResource() {
      throw new Error("this journey must not fetch rendered image artifacts");
    },
    async readResource() {
      throw new Error("a blocked catalog preflight must not read MCP resources");
    },
    async runGpServer() {
      throw new Error("a blocked catalog preflight must not execute GPServer jobs");
    },
    async readReceipt() {
      return undefined;
    },
    async checkHttp() {
      throw new Error("a blocked catalog preflight must not make HTTP requests");
    },
  };
}

function deterministicClock(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 7, 20, 12, 0, seconds++));
}
