import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_PUBLISHED_TOOL_NAMES, MCP_DEFAULT_STATIC_TOOL_COUNT } from "@honua/sdk-js/control-plane";
import { describe, expect, it } from "vitest";

import {
  type ZeroToMapCheckpointBindings,
  assertZeroToMapCheckpointBindings,
  assertZeroToMapCheckpointDigest,
  assertZeroToMapCheckpointFresh,
  consumeZeroToMapCheckpoint,
  createZeroToMapCheckpoint,
  parseZeroToMapCheckpoint,
} from "../../src/release/zero-to-map-checkpoint.js";
import { claimZeroToMapCheckpoint, parseZeroToMapCliArgs } from "../../src/release/zero-to-map-cli.js";
import { assertAwsEcsProvisionBindings, parseAwsEcsProvisionBinding } from "../../src/release/zero-to-map-provision.js";
import {
  type JourneyAdapter,
  type JourneyPauseSnapshot,
  ZERO_TO_MAP_ADDITIVE_PROFILES,
  ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
  parseZeroToMapPlan,
  runZeroToMapJourney,
} from "../../src/release/zero-to-map.js";

const bindings: ZeroToMapCheckpointBindings = {
  journeyId: "checkpoint-fixture",
  releaseContract: "fixture/v1",
  target: "local-docker",
  planSha256: "1".repeat(64),
  sourceRevision: "2".repeat(40),
  mcpEndpointSha256: "3".repeat(64),
  candidateId: `manifest-sha256:${"4".repeat(64)}`,
  releaseId: "2026.1",
};

function completeCatalog(requiredTool: string) {
  const profileNames = ZERO_TO_MAP_ADDITIVE_PROFILES.flatMap((profile) => [
    ...profile.confirmedMembers,
    ...Array.from(
      { length: profile.memberCount - profile.confirmedMembers.length },
      (_, index) => `honua_fixture_${profile.id.replace(/-/g, "_")}_${String(index).padStart(2, "0")}`,
    ),
  ]);
  const staticNames = new Set(profileNames.includes(requiredTool) ? [] : [requiredTool]);
  for (let index = 0; staticNames.size < MCP_DEFAULT_STATIC_TOOL_COUNT; index += 1) {
    staticNames.add(`honua_fixture_static_${String(index).padStart(2, "0")}`);
  }
  return [...ADMIN_MCP_PUBLISHED_TOOL_NAMES, ...staticNames, ...profileNames].map((name) => ({
    name,
    inputSchema: { type: "object" },
  }));
}

function fixturePlan() {
  return parseZeroToMapPlan({
    schemaVersion: "honua.zero-to-map.plan/v1",
    journeyId: bindings.journeyId,
    releaseContract: bindings.releaseContract,
    fixtures: [],
    dependencyRefs: [],
    variables: { serviceName: "zero-to-map" },
    stages: [1, 2, 3, 4, 5]
      .map((number) => ({
        number,
        id: `stage-${number}`,
        title: `Stage ${number}`,
        actions: [
          {
            id: `mutation-${number}`,
            title: `Mutation ${number}`,
            kind: "cli",
            args: ["mutation", String(number)],
            captures: [{ variable: `id${number}`, pointers: ["/id"] }],
          },
        ],
      }))
      .concat([
        {
          number: 6,
          id: "console",
          title: "Console",
          actions: [
            {
              id: "console-approval",
              title: "Approval",
              kind: "receipt",
              receiptSchema: ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
              matches: { "/journeyId": "${journeyId}", "/resourceId": "${id5}" },
              requiredPointers: ["/approvalId", "/shareUrl"],
              captures: [
                { variable: "approvalId", pointers: ["/approvalId"] },
                { variable: "shareUrl", pointers: ["/shareUrl"] },
              ],
            },
          ],
        },
        {
          number: 7,
          id: "artifact",
          title: "Artifact",
          actions: [
            {
              id: "verify-share",
              title: "Verify share",
              kind: "http",
              url: "${shareUrl}",
              expectedStatus: 200,
            },
          ],
        },
      ]),
  });
}

describe("zero-to-map pause/resume checkpoint", () => {
  it("resumes at Console without replaying the five completed mutation stages", async () => {
    const plan = fixturePlan();
    let mutations = 0;
    let snapshot: JourneyPauseSnapshot | undefined;
    const first = await runZeroToMapJourney(
      plan,
      adapter({
        runCli: async () => ({ value: { id: `runtime-${++mutations}` } }),
      }),
      {
        execute: true,
        variables: {
          dbPassword: "must-never-persist",
          fixtureBaseUrl: "https://fixtures.example.test/",
        },
        now: clock(),
        onExternalReceiptMissing(value) {
          snapshot = value;
        },
      },
    );

    expect(first.status).toBe("blocked");
    expect(mutations).toBe(5);
    expect(snapshot?.resumeAt).toEqual({ stageId: "console", actionId: "console-approval" });
    const checkpoint = createZeroToMapCheckpoint(bindings, snapshot as JourneyPauseSnapshot, "2026-08-20T12:00:00Z");
    expect(JSON.stringify(checkpoint)).not.toContain("must-never-persist");
    expect(checkpoint.resume.capturedVariables.serviceName).toBe("zero-to-map");
    expect(checkpoint.resume.capturedVariables.fixtureBaseUrl).toBe("https://fixtures.example.test");
    expect(checkpoint.consoleReceiptRequest.matches).toMatchObject({
      "/journeyId": bindings.journeyId,
      "/resourceId": "runtime-5",
    });

    const httpCalls: string[] = [];
    const resumed = await runZeroToMapJourney(
      plan,
      adapter({
        runCli: async () => {
          throw new Error("mutations must not replay");
        },
        readReceipt: async () => ({
          value: {
            schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
            journeyId: bindings.journeyId,
            status: "passed",
            resourceId: "runtime-5",
            approvalId: "approval-1",
            shareUrl: "https://example.test/app",
          },
        }),
        checkHttp: async (url) => {
          httpCalls.push(url);
          return { evidence: { status: 200 } };
        },
      }),
      {
        execute: true,
        resume: parseZeroToMapCheckpoint(checkpoint).resume,
        now: clock(),
      },
    );

    expect(resumed.status).toBe("passed");
    expect(resumed.stages.slice(0, 5)).toEqual(first.stages.slice(0, 5));
    expect(mutations).toBe(5);
    expect(httpCalls).toEqual(["https://example.test/app"]);

    await expect(
      runZeroToMapJourney(plan, adapter({}), {
        execute: true,
        resume: {
          ...checkpoint.resume,
          capturedVariables: { ...checkpoint.resume.capturedVariables, serviceName: "lookalike-service" },
        },
      }),
    ).rejects.toThrow("checkpoint seed serviceName");
  });

  it("rejects tampering, stale or mismatched bindings, credential captures, and consumed replay", async () => {
    const snapshot = await pausedSnapshot();
    const checkpoint = createZeroToMapCheckpoint(bindings, snapshot, "2026-08-20T12:00:00Z");
    const tampered = structuredClone(checkpoint) as unknown as Record<string, unknown>;
    tampered.candidateId = `manifest-sha256:${"9".repeat(64)}`;
    expect(() => parseZeroToMapCheckpoint(tampered)).toThrow("integrity digest");
    const resealedTamper = createZeroToMapCheckpoint(
      { ...bindings, candidateId: `manifest-sha256:${"9".repeat(64)}` },
      snapshot,
      "2026-08-20T12:00:00Z",
    );
    expect(() => assertZeroToMapCheckpointDigest(resealedTamper, checkpoint.integrity.digest)).toThrow(
      "externally carried",
    );
    expect(() => assertZeroToMapCheckpointFresh(checkpoint, new Date("2026-08-22T12:00:01Z"))).toThrow("stale");

    for (const [key, value] of [
      ["candidateId", `manifest-sha256:${"5".repeat(64)}`],
      ["planSha256", "6".repeat(64)],
      ["sourceRevision", "7".repeat(40)],
      ["mcpEndpointSha256", "8".repeat(64)],
      ["target", "aws-ecs"],
    ] as const) {
      expect(() => assertZeroToMapCheckpointBindings(checkpoint, { ...bindings, [key]: value })).toThrow(key);
    }
    const awsCheckpoint = createZeroToMapCheckpoint(
      { ...bindings, target: "aws-ecs", provisionReceiptSha256: "b".repeat(64) },
      snapshot,
    );
    expect(() =>
      assertZeroToMapCheckpointBindings(awsCheckpoint, {
        ...bindings,
        target: "aws-ecs",
        provisionReceiptSha256: "c".repeat(64),
      }),
    ).toThrow("provisionReceiptSha256");

    expect(() =>
      createZeroToMapCheckpoint(bindings, {
        ...snapshot,
        capturedVariables: { ...snapshot.capturedVariables, dbPassword: "leaked" },
      }),
    ).toThrow("forbidden credential field");

    const secretFreeAccess = structuredClone(snapshot);
    const firstAction = secretFreeAccess.completedStages[0]?.actions[0];
    if (!firstAction) throw new Error("fixture action missing");
    (firstAction as { evidence?: Readonly<Record<string, unknown>> }).evidence = {
      accessCredential: {
        id: "11111111-1111-4111-8111-111111111111",
        requestedGrants: ["admin:read", "admin:write"],
        effectiveGrants: ["admin:read", "admin:write"],
        referenceDigestSha256: "a".repeat(64),
      },
    };
    expect(() => createZeroToMapCheckpoint(bindings, secretFreeAccess)).not.toThrow();
    (firstAction as { evidence?: Readonly<Record<string, unknown>> }).evidence = {
      material: "must-never-enter-a-checkpoint",
    };
    expect(() => createZeroToMapCheckpoint(bindings, secretFreeAccess)).toThrow("forbidden credential field");

    const consumed = consumeZeroToMapCheckpoint(checkpoint, "a".repeat(64), "2026-08-20T12:10:00Z");
    expect(parseZeroToMapCheckpoint(consumed).state).toBe("consumed");
    expect(() => consumeZeroToMapCheckpoint(consumed, "b".repeat(64))).toThrow("already been consumed");
  });

  it("allows exactly one concurrent resume claimant", async () => {
    const root = await mkdtemp(join(tmpdir(), "honua-zero-to-map-"));
    try {
      const checkpoint = createZeroToMapCheckpoint(bindings, await pausedSnapshot());
      const path = join(root, "checkpoint.json");
      await writeFile(path, JSON.stringify(checkpoint), "utf8");
      const claims = await Promise.allSettled([
        claimZeroToMapCheckpoint(path, checkpoint.integrity.digest),
        claimZeroToMapCheckpoint(path, checkpoint.integrity.digest),
      ]);
      expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
      expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
      await expect(claimZeroToMapCheckpoint(path, checkpoint.integrity.digest)).rejects.toThrow("already claimed");

      const consumedPath = join(root, "consumed.json");
      const consumed = consumeZeroToMapCheckpoint(checkpoint, "a".repeat(64));
      await writeFile(consumedPath, JSON.stringify(consumed), "utf8");
      await expect(claimZeroToMapCheckpoint(consumedPath, consumed.integrity.digest)).rejects.toThrow(
        "already been consumed",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the database password from an environment variable without placing it in argv", () => {
    const argv = ["--var-env", "dbPassword=HONUA_ZERO_TO_MAP_DB_PASSWORD"];
    const options = parseZeroToMapCliArgs(argv, { HONUA_ZERO_TO_MAP_DB_PASSWORD: "environment-only" });
    expect(options.variables.dbPassword).toBe("environment-only");
    expect(argv.join(" ")).not.toContain("environment-only");
    expect(() => parseZeroToMapCliArgs(argv, {})).toThrow("missing or empty environment value");
  });

  it("strictly binds the producer-owned AWS ECS provision handoff", () => {
    const candidateId = `manifest-sha256:${"a".repeat(64)}`;
    const adminKeySecretRef = "arn:aws:secretsmanager:us-west-2:123456789012:secret:honua/admin-key";
    const binding = parseAwsEcsProvisionBinding({
      schemaVersion: "honua.aws-ecs.provision-binding/v1",
      target: "aws-ecs",
      status: "ready",
      candidateId,
      releaseId: "2026.1",
      endpoint: "https://candidate.example.test",
      adminKeySecretRef,
      accessCredential: {
        id: "11111111-1111-4111-8111-111111111111",
        requestedGrants: ["admin:read", "admin:write"],
        effectiveGrants: ["admin:read", "admin:write"],
        status: "active",
        canAuthenticate: true,
        referenceType: "aws-secrets-manager",
        referenceDigestSha256: createHash("sha256").update(adminKeySecretRef, "utf8").digest("hex"),
      },
      serverImage: `ghcr.io/honua-io/honua-server:2026.1@sha256:${"b".repeat(64)}`,
      components: {
        "honua-server": "c".repeat(40),
        "honua-devops": "d".repeat(40),
        "honua-iac": "e".repeat(40),
      },
      checks: {
        "terraform-plan": "passed",
        "terraform-apply": "passed",
        readiness: "passed",
        "admin-mcp-handoff": "passed",
      },
      evidence: { url: "https://evidence.example.test/provision.json", sha256: "f".repeat(64) },
    });
    expect(() =>
      assertAwsEcsProvisionBindings(binding, {
        candidateId,
        releaseId: "2026.1",
        mcpUrl: "https://candidate.example.test/mcp",
      }),
    ).not.toThrow();
    expect(() =>
      assertAwsEcsProvisionBindings(binding, {
        candidateId,
        releaseId: "2026.1",
        mcpUrl: "https://different.example.test/mcp",
      }),
    ).toThrow("does not match --mcp-url");
    expect(() => parseAwsEcsProvisionBinding({ ...binding, endpoint: "http://127.0.0.1:8080" })).toThrow(
      "public HTTPS",
    );
    expect(() =>
      parseAwsEcsProvisionBinding({
        ...binding,
        accessCredential: {
          ...binding.accessCredential,
          requestedGrants: ["admin:approve", "admin:read", "admin:write"],
          effectiveGrants: ["admin:approve", "admin:read", "admin:write"],
        },
      }),
    ).toThrow("not scoped to the required release grants");
  });

  it("carries the catalog preflight evidence across the Console pause onto the resumed receipt", async () => {
    // Stages 6 and 7 issue no MCP action, so a resumed run has nothing to
    // re-derive the preflight from. Its receipt overwrites the pre-pause one,
    // so without the checkpoint carrying it every successful release receipt
    // would lose the active-profile and roster-digest evidence entirely.
    const plan = catalogFixturePlan();
    let snapshot: JourneyPauseSnapshot | undefined;
    let listToolsCalls = 0;
    const paused = await runZeroToMapJourney(
      plan,
      adapter({
        runCli: async () => ({ value: { id: "runtime" } }),
        listTools: async () => {
          listToolsCalls += 1;
          return completeCatalog("honua_studio_propose_publication");
        },
        callTool: async () => ({ value: { structuredContent: { id: "runtime-5", recorded: true } } }),
      }),
      {
        execute: true,
        now: clock(),
        onExternalReceiptMissing: (value) => {
          snapshot = value;
        },
      },
    );
    expect(paused.status).toBe("blocked");
    expect(listToolsCalls).toBe(1);
    expect(paused.catalog?.schemaVersion).toBe("honua.zero-to-map.catalog/v1");
    expect(paused.catalog?.activeProfiles.length).toBeGreaterThan(0);

    const sealed = createZeroToMapCheckpoint(bindings, snapshot as JourneyPauseSnapshot, "2026-08-20T12:00:00Z");
    expect(sealed.resume.catalog).toEqual(paused.catalog);
    // Survives the strict parse, integrity digest included.
    const parsed = parseZeroToMapCheckpoint(JSON.parse(JSON.stringify(sealed)) as unknown);
    expect(parsed.resume.catalog).toEqual(paused.catalog);

    const resumed = await runZeroToMapJourney(
      plan,
      adapter({
        runCli: async () => {
          throw new Error("mutations must not replay");
        },
        readReceipt: async () => ({
          value: {
            schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA,
            journeyId: bindings.journeyId,
            status: "passed",
            resourceId: "runtime-5",
            approvalId: "approval-1",
            shareUrl: "https://example.test/app",
          },
        }),
        checkHttp: async () => ({ evidence: { status: 200 } }),
      }),
      { execute: true, resume: parsed.resume, now: clock() },
    );

    expect(resumed.status).toBe("passed");
    // The evidence the successful receipt is judged on, not just any catalog.
    expect(resumed.catalog).toEqual(paused.catalog);
    // Restored, never re-derived: stages 6 and 7 never reach the adapter.
    expect(listToolsCalls).toBe(1);
  });

  it("refuses a checkpoint whose catalog evidence was padded or malformed", async () => {
    const snapshot = await pausedSnapshot();
    const withCatalog: JourneyPauseSnapshot = {
      ...snapshot,
      catalog: {
        schemaVersion: "honua.zero-to-map.catalog/v1",
        activeProfiles: ["base"],
        expectedTotalTools: 441,
        advertisedTotalTools: 441,
        baseStaticTools: 47,
        baseAdminTools: 385,
        auditedExclusions: 11,
        profiles: [],
        catalogSha256: "a".repeat(64),
        adminRosterSha256: "b".repeat(64),
        staticRosterSha256: "c".repeat(64),
        exclusionRosterSha256: "d".repeat(64),
      },
    };
    const sealed = createZeroToMapCheckpoint(bindings, withCatalog, "2026-08-20T12:00:00Z");
    expect(parseZeroToMapCheckpoint(JSON.parse(JSON.stringify(sealed)) as unknown).resume.catalog).toEqual(
      withCatalog.catalog,
    );

    for (const [mutate, message] of [
      [(catalog: Record<string, unknown>) => ({ ...catalog, smuggled: "extra" }), "unknown fields"],
      [(catalog: Record<string, unknown>) => ({ ...catalog, schemaVersion: "honua.other/v1" }), "schemaVersion"],
      [(catalog: Record<string, unknown>) => ({ ...catalog, catalogSha256: "not-a-digest" }), "catalogSha256"],
      [(catalog: Record<string, unknown>) => ({ ...catalog, advertisedTotalTools: -1 }), "advertisedTotalTools"],
    ] as const) {
      const broken = JSON.parse(JSON.stringify(sealed)) as Record<string, unknown>;
      const resume = broken.resume as Record<string, unknown>;
      resume.catalog = mutate(resume.catalog as Record<string, unknown>);
      expect(() => parseZeroToMapCheckpoint(broken)).toThrow(message);
    }
  });

  it("rejects publication identity or URL leakage before Console approval", async () => {
    const source = fixturePlan();
    const plan = {
      ...source,
      stages: source.stages.map((stage) =>
        stage.number === 5
          ? {
              ...stage,
              actions: [
                {
                  id: "propose-map-publication",
                  title: "Propose map",
                  kind: "mcp" as const,
                  tool: "honua_studio_propose_publication",
                  arguments: {},
                  forbiddenPointers: ["/structuredContent/publicationId", "/structuredContent/publicUrl"],
                },
              ],
            }
          : stage,
      ),
    };
    const receipt = await runZeroToMapJourney(
      plan,
      adapter({
        runCli: async () => ({ value: { id: "runtime" } }),
        listTools: async () => completeCatalog("honua_studio_propose_publication"),
        callTool: async () => ({
          value: {
            structuredContent: {
              recorded: true,
              humanConfirmationRequired: true,
              publicationId: "must-not-exist",
              publicUrl: "https://must-not-exist.example.test",
            },
          },
        }),
      }),
      { execute: true, now: clock() },
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.stages[4]?.actions[0]).toMatchObject({
      status: "failed",
      message: expect.stringContaining("forbidden pre-approval evidence"),
    });
  });
});

/** The fixture plan with stage 5 replaced by a passing MCP action. */
function catalogFixturePlan() {
  const source = fixturePlan();
  return {
    ...source,
    stages: source.stages.map((stage) =>
      stage.number === 5
        ? {
            ...stage,
            actions: [
              {
                id: "propose-map-publication",
                title: "Propose map",
                kind: "mcp" as const,
                tool: "honua_studio_propose_publication",
                arguments: {},
                captures: [{ variable: "id5", pointers: ["/structuredContent/id"] }],
              },
            ],
          }
        : stage,
    ),
  };
}

async function pausedSnapshot(): Promise<JourneyPauseSnapshot> {
  let snapshot: JourneyPauseSnapshot | undefined;
  let count = 0;
  await runZeroToMapJourney(
    fixturePlan(),
    adapter({
      runCli: async () => ({ value: { id: `runtime-${++count}` } }),
    }),
    {
      execute: true,
      now: clock(),
      onExternalReceiptMissing(value) {
        snapshot = value;
      },
    },
  );
  if (!snapshot) throw new Error("fixture did not pause");
  return snapshot;
}

function adapter(overrides: Partial<JourneyAdapter>): JourneyAdapter {
  const fail = () => Promise.reject(new Error("unexpected adapter call"));
  return {
    runCli: overrides.runCli ?? fail,
    listTools: overrides.listTools ?? fail,
    callTool: overrides.callTool ?? fail,
    readResource: overrides.readResource ?? fail,
    runGpServer: overrides.runGpServer ?? fail,
    readReceipt: overrides.readReceipt ?? (async () => undefined),
    checkHttp: overrides.checkHttp ?? fail,
  };
}

function clock(): () => Date {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 20, 12, 0, second++));
}
