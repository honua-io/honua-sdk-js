import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readJourneyMcpResource, requireCompletedPublishedOperation } from "../../src/release/zero-to-map-cli.js";
import {
  type JourneyAdapter,
  type JourneyBlockedError,
  type JourneyExecutionResult,
  ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
  parseZeroToMapPlan,
  runZeroToMapJourney,
} from "../../src/release/zero-to-map.js";

const bundleRoot = fileURLToPath(new URL("../../release/zero-to-map/", import.meta.url));

async function loadPlan() {
  return parseZeroToMapPlan(JSON.parse(await readFile(`${bundleRoot}/journey.v1.json`, "utf8")) as unknown);
}

describe("zero-to-map D9.3 release journey", () => {
  it("ships a seven-stage plan and small deterministic GeoJSON fixtures", async () => {
    const plan = await loadPlan();
    expect(plan.stages.map((stage) => stage.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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

    const esriGpContract = JSON.parse(await readFile(`${bundleRoot}/contracts/esri-gp-mcp.v1.json`, "utf8")) as {
      schemaVersion: string;
      tools: Array<{ name: string; inputSchema: unknown; output: { required: string[] } }>;
    };
    expect(esriGpContract.schemaVersion).toBe("honua.esri-gp-mcp-contract/v1");
    expect(esriGpContract.tools.map((tool) => tool.name)).toEqual([
      "honua_esri_gp_list_tasks",
      "honua_esri_gp_describe_task",
      "honua_esri_gp_execute_task",
    ]);
    expect(esriGpContract.tools[2]).toMatchObject({
      inputSchema: {
        required: ["serviceId", "taskName", "parameters"],
        additionalProperties: false,
      },
      output: {
        required: ["jobId", "status", "resourceUri", "serviceId", "taskName", "processId"],
      },
    });

    const geoprocessing = new Map(plan.stages[2]?.actions.map((action) => [action.id, action]));
    expect(geoprocessing.get("list-esri-gp-tasks")).toMatchObject({
      kind: "mcp",
      tool: "honua_esri_gp_list_tasks",
      arguments: {},
    });
    expect(geoprocessing.get("describe-esri-buffer")).toMatchObject({
      kind: "mcp",
      tool: "honua_esri_gp_describe_task",
      arguments: { taskName: "Buffer" },
      captures: [
        { variable: "esriGpTaskName", equals: "Buffer" },
        { variable: "esriGpProcessId", equals: "geometry.buffer" },
      ],
    });
    expect(geoprocessing.get("buffer-esri-mcp")).toMatchObject({
      kind: "mcp",
      tool: "honua_esri_gp_execute_task",
      arguments: {
        serviceId: "analysis",
        taskName: "Buffer",
        parameters: {
          wkb: {
            geometryType: "esriGeometryPolygon",
            spatialReference: { wkid: 4326 },
            features: [{ attributes: { parcel_id: "P-101" } }],
          },
          distance: 0.00025,
        },
      },
    });
    expect(geoprocessing.get("wait-esri-mcp-buffer")).toMatchObject({
      kind: "mcp-resource",
      uri: "honua://jobs/${esriMcpJobId}",
      waitFor: { equals: "Succeeded", terminal: ["Succeeded", "Failed", "Cancelled"] },
    });
    expect(geoprocessing.get("read-esri-mcp-buffer-results")).toMatchObject({
      kind: "mcp-resource",
      uri: "${esriMcpResultsUri}",
    });
    expect(geoprocessing.get("buffer-esri-gpserver")).toMatchObject({
      kind: "gpserver",
      captures: [{ variable: "gpServerJobId", pointers: ["/jobId"] }],
    });
    expect(geoprocessing.get("buffer-parcels")).toMatchObject({
      kind: "mcp",
      tool: "honua_buffer_features",
      captures: [{ variable: "directAnalysisJobId", pointers: ["/structuredContent/jobId"] }],
    });
    expect(geoprocessing.get("read-direct-buffer-results")).toMatchObject({
      kind: "mcp-resource",
      captures: expect.arrayContaining([expect.objectContaining({ variable: "bufferArtifactId" })]),
    });

    const consoleContract = JSON.parse(
      await readFile(`${bundleRoot}/contracts/console-receipt.schema.json`, "utf8"),
    ) as {
      required: string[];
      properties: Record<string, { required?: string[] }>;
    };
    expect(consoleContract.required).toEqual(
      expect.arrayContaining(["proposal", "audit", "resources", "candidate", "checks", "shareUrl"]),
    );
    expect(consoleContract.properties.proposal?.required).toEqual(
      expect.arrayContaining(["proposalId", "executionOperationId"]),
    );
    expect(consoleContract.properties.audit?.required).toEqual(["correlationId", "operationId"]);

    const admin = new Map(plan.stages[1]?.actions.map((action) => [action.id, action]));
    expect(admin.get("create-connection")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_connection_create",
      captures: [
        {
          pointers: ["/structuredContent/details/response"],
          parsedPointers: ["/data/connectionId"],
        },
      ],
    });
    expect(admin.get("test-connection")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_connection_test",
      arguments: { id: "${connectionId}" },
    });
    expect(admin.get("publish-parcels")).toMatchObject({
      kind: "mcp",
      tool: "honua_admin_layer_publish",
      arguments: { id: "${connectionId}" },
      captures: [
        {
          pointers: ["/structuredContent/details/response"],
          parsedPointers: ["/data/layerId"],
        },
      ],
    });
    expect(plan.stages[1]?.actions.filter((action) => action.kind === "mcp").map((action) => action.tool)).toEqual([
      "honua_admin_server_status",
      "honua_admin_connection_create",
      "honua_admin_connection_test",
      "honua_admin_import_upload_url",
      "honua_admin_import_upload_url",
      "honua_admin_layer_publish",
      "honua_admin_layer_publish",
      "honua_admin_service_set_access_policy",
      "honua_admin_api_key_create",
    ]);
  });

  it("honors the server PublishedOperation handle instead of guessing top-level endpoint ids", () => {
    const completed = adminOperation("admin.connection.create", { data: { connectionId: "connection-1" } }).value;
    expect(requireCompletedPublishedOperation("honua_admin_connection_create", completed)).toMatchObject({
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

  it("preflights the complete MCP catalog before the first server mutation", async () => {
    const plan = await loadPlan();
    const calls: string[] = [];
    const adapter: JourneyAdapter = {
      async runCli(args) {
        calls.push(`cli:${args.join(" ")}`);
        return {};
      },
      async listTools() {
        calls.push("tools/list");
        return [];
      },
      async callTool(tool) {
        calls.push(`tools/call:${tool}`);
        return {};
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
      async runCli() {
        return {};
      },
      async listTools() {
        return requiredTools.map((name) => ({
          name,
          inputSchema:
            name === "honua_admin_connection_create"
              ? {
                  type: "object",
                  additionalProperties: false,
                  required: ["body"],
                  properties: { body: { type: "string" } },
                }
              : { type: "object" },
        }));
      },
      async callTool(tool) {
        calls.push(tool);
        return {};
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

  it("rejects a passed Console receipt that is not bound to this journey", async () => {
    const source = await loadPlan();
    const plan = {
      ...source,
      stages: source.stages.map((stage) =>
        stage.number < 6
          ? {
              ...stage,
              actions: [{ id: `fixture-${stage.number}`, title: "fixture", kind: "cli" as const, args: [] }],
            }
          : stage,
      ),
    };
    const adapter: JourneyAdapter = {
      async runCli() {
        return {};
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      async readResource() {
        return {};
      },
      async runGpServer() {
        return {};
      },
      async readReceipt() {
        return {
          value: {
            schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
            journeyId: "some-other-journey",
            releaseContract: source.releaseContract,
            status: "passed",
          },
        };
      },
      async checkHttp() {
        return {};
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, { execute: true, now: deterministicClock() });
    expect(receipt.status).toBe("failed");
    expect(receipt.stages[5]?.actions[0]).toMatchObject({
      status: "failed",
      message: "console-approval receipt identity mismatch at /journeyId",
    });
  });

  it("threads captured ids and generations through a fully simulated live journey", async () => {
    const plan = await loadPlan();
    const requiredTools = plan.stages.flatMap((stage) =>
      stage.actions.filter((action) => action.kind === "mcp").map((action) => action.tool),
    );
    const seenArguments = new Map<string, Readonly<Record<string, unknown>>>();
    let layerId = 0;
    let generation = 0;
    const adapter: JourneyAdapter = {
      async runCli() {
        return { evidence: { exitCode: 0 } };
      },
      async listTools() {
        return requiredTools.map((name) => ({ name, inputSchema: { type: "object" } }));
      },
      async callTool(tool, args) {
        seenArguments.set(tool, args);
        if (tool === "honua_admin_connection_create") {
          return adminOperation("admin.connection.create", { data: { connectionId: "connection-1" } });
        }
        if (tool === "honua_admin_layer_publish") {
          layerId += 1;
          return adminOperation("admin.layer.publish", { data: { layerId } });
        }
        if (tool === "honua_buffer_features") {
          return value({
            jobId: "direct-buffer-1",
            status: "queued",
            resourceUri: "honua://jobs/direct-buffer-1",
            artifacts: [],
          });
        }
        if (tool === "honua_esri_gp_list_tasks") {
          return value({
            tasks: [
              {
                taskName: "Buffer",
                processId: "geometry.buffer",
                displayName: "Buffer",
                category: "geometry",
                isAlias: true,
                supportsSynchronousExecution: false,
              },
            ],
          });
        }
        if (tool === "honua_esri_gp_describe_task") {
          return value({
            taskName: "Buffer",
            processId: "geometry.buffer",
            displayName: "Buffer",
            description: "Buffer geometry",
            category: "geometry",
            executionType: "esriExecutionTypeAsynchronous",
            supportsSynchronousExecution: false,
            parameters: [],
          });
        }
        if (tool === "honua_esri_gp_execute_task") {
          return value({
            jobId: "esri-mcp-buffer-1",
            status: "queued",
            resourceUri: "honua://jobs/esri-mcp-buffer-1",
            serviceId: "analysis",
            taskName: "Buffer",
            processId: "geometry.buffer",
          });
        }
        if (tool === "honua_studio_create_draft") {
          generation = 1;
          return value({ draftId: "11111111-1111-4111-8111-111111111111", generation });
        }
        if (tool.startsWith("honua_studio_") && tool !== "honua_studio_validate_draft") {
          generation += 1;
          return tool === "honua_studio_propose_publication"
            ? value({
                draft: { draftId: "11111111-1111-4111-8111-111111111111", generation },
                recorded: true,
                humanConfirmationRequired: true,
              })
            : value({ draftId: "11111111-1111-4111-8111-111111111111", generation });
        }
        return value({ ok: true });
      },
      async readResource(action) {
        const jobId = action.uri.includes("esri-mcp-buffer-1") ? "esri-mcp-buffer-1" : "direct-buffer-1";
        if (action.uri.endsWith("/results")) {
          const artifactId = jobId === "esri-mcp-buffer-1" ? "artifact-esri-mcp-1" : "artifact-buffer-1";
          return resourceValue(action.uri, {
            jobId,
            resultPackageId: `results-${jobId}`,
            status: "Succeeded",
            artifacts: [{ artifactId, kind: "FeatureLayer", label: "Buffer output" }],
          });
        }
        return resourceValue(action.uri, {
          jobId,
          status: "Succeeded",
          resultsUri: `honua://jobs/${jobId}/results`,
        });
      },
      async runGpServer(action) {
        expect(action).toMatchObject({
          serviceId: "geoprocessing",
          taskName: "Buffer",
          processId: "geometry.buffer",
          parameters: { srid: 4326, distance: 0.00025 },
          resultNames: ["outputFeatureLayer"],
        });
        return {
          value: {
            jobId: "gp-buffer-1",
            status: "successful",
            outputs: { outputFeatureLayer: { value: "data:application/geo+json;base64,e30=" } },
          },
          evidence: { protocol: "geoservices-gp" },
        };
      },
      async readReceipt(actionId) {
        expect(actionId).toBe("console-approval");
        return {
          value: {
            schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
            journeyId: plan.journeyId,
            releaseContract: plan.releaseContract,
            status: "passed",
            proposal: {
              draftId: "11111111-1111-4111-8111-111111111111",
              generation,
              route: "zero-to-map",
              proposalId: "proposal-1",
              executionOperationId: "operation-1",
            },
            audit: { correlationId: "correlation-1", operationId: "operation-1" },
            resources: {
              connectionId: "connection-1",
              serviceId: "zero-to-map",
              layerIds: { parcels: 1, zoning: 2 },
              jobs: {
                esriMcp: "esri-mcp-buffer-1",
                gpServer: "gp-buffer-1",
                directAnalysis: "direct-buffer-1",
              },
              gp: {
                jobId: "esri-mcp-buffer-1",
                serviceId: "analysis",
                taskName: "Buffer",
                processId: "geometry.buffer",
                resultPackageId: "results-esri-mcp-buffer-1",
                artifactId: "artifact-esri-mcp-1",
              },
              gpServerResultNames: ["outputFeatureLayer"],
              artifactId: "artifact-buffer-1",
              draftId: "11111111-1111-4111-8111-111111111111",
            },
            candidate: { candidateId: "candidate-1", releaseId: "release-1" },
            checks: { health: "passed", audit: "passed", recovery: "passed" },
            shareUrl: "https://example.test/apps/zero-to-map",
          },
          evidence: { sha256: "fixture" },
        };
      },
      async checkHttp(url, expectedStatus) {
        expect(url).toBe("https://example.test/apps/zero-to-map");
        expect(expectedStatus).toBe(200);
        return { evidence: { status: 200 } };
      },
    };

    const receipt = await runZeroToMapJourney(plan, adapter, {
      execute: true,
      now: deterministicClock(),
      variables: {
        dbPassword: "not-recorded",
        fixtureBaseUrl: "https://fixtures.example.test",
      },
    });

    expect(receipt.status, JSON.stringify(receipt, null, 2)).toBe("passed");
    expect(receipt.blockers).toEqual([]);
    expect(receipt.dependencyRefs).toContain("honua-server#3268 synchronous OGC process execution and GeoJSON inputs");
    expect(receipt.stages.every((stage) => stage.status === "passed")).toBe(true);
    expect(seenArguments.get("honua_admin_connection_test")).toEqual({ id: "connection-1" });
    expect(seenArguments.get("honua_buffer_features")).toMatchObject({
      source: { serviceId: "zero-to-map", layerId: 1 },
    });
    expect(seenArguments.get("honua_esri_gp_execute_task")).toMatchObject({
      serviceId: "analysis",
      taskName: "Buffer",
      parameters: {
        wkb: {
          geometryType: "esriGeometryPolygon",
          spatialReference: { wkid: 4326 },
          features: [{ attributes: { parcel_id: "P-101" } }],
        },
        distance: 0.00025,
      },
    });
    expect(seenArguments.get("honua_studio_add_layer")).toMatchObject({
      draftId: "11111111-1111-4111-8111-111111111111",
    });
  });
});

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

function neverCalledAdapter(): JourneyAdapter {
  const fail = () => Promise.reject(new Error("adapter was unexpectedly called"));
  return {
    runCli: fail,
    listTools: fail,
    callTool: fail,
    readResource: fail,
    runGpServer: fail,
    readReceipt: fail,
    checkHttp: fail,
  };
}

function deterministicClock(): () => Date {
  let seconds = 0;
  return () => new Date(Date.UTC(2026, 7, 20, 12, 0, seconds++));
}
