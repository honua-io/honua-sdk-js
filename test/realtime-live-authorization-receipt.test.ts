import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUTHORIZATION_SCENARIOS,
  AUTHORIZATION_SURFACES,
  type AuthorizationRow,
  ENFORCEMENT_BOUND_MS,
  type LiveAuthorizationOptions,
  type LiveAuthorizationReceipt,
  REALTIME_PREVIEW_EVIDENCE_FORMAT,
  assertNoRetainedCredentials,
  authorizationTranscriptReasons,
  collectLiveAuthorizationReceipt,
  isAuthorizationTermination,
  issuerFingerprint,
  mintIssuerJwt,
  normalizeLiveAuthorizationEnv,
  summarizeLiveAuthorizationReceipt,
} from "../scripts/realtime-live-authorization-receipt.mjs";
import {
  FAKE_CANDIDATE_IMAGE,
  FAKE_CANDIDATE_REVISION,
  type FakeCandidate,
  type FakeCandidateDefects,
  startFakeCandidate,
} from "./helpers/realtime-live-candidate-fake.js";

const ISSUER = {
  issuer: "https://issuer.fixture.invalid",
  audience: "honua-realtime-fixture",
  signingKey: "fixture-signing-key-0123456789abcdef0123456789",
  clockSkewSeconds: 0,
};
const ADMIN_API_KEY = "FixtureAdmin1692!";
const SDK_REVISION = "ab".repeat(20);
const RUN_TIMEOUT_MS = 120_000;

function optionsFor(candidate: FakeCandidate): LiveAuthorizationOptions {
  return {
    baseUrl: candidate.baseUrl,
    adminApiKey: ADMIN_API_KEY,
    serverRevision: FAKE_CANDIDATE_REVISION,
    serverImage: FAKE_CANDIDATE_IMAGE,
    environment: "fixture-two-tenant",
    deploymentFingerprint: null,
    referer: "https://fixture.invalid/",
    issuer: ISSUER,
    tokenExpirationMinutes: 1,
    sdk: { package: "@honua/sdk-js@0.0.0-fixture", version: "0.0.0-fixture", revision: SDK_REVISION },
    workflow: {
      repository: "honua-io/honua-sdk-js",
      name: "Realtime Cross-Transport Conformance",
      runId: "1692",
      runAttempt: "1",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    },
    runTag: "fixture",
    timing: { requestTimeoutMs: 5_000, deliveryTimeoutMs: 5_000, negativeSettleMs: 200, observationSettleMs: 150 },
  };
}

async function mint(
  defects?: FakeCandidateDefects,
): Promise<{ candidate: FakeCandidate; receipt: LiveAuthorizationReceipt }> {
  const candidate = await startFakeCandidate({
    issuer: ISSUER.issuer,
    audience: ISSUER.audience,
    signingKey: ISSUER.signingKey,
    adminApiKey: ADMIN_API_KEY,
    defects,
  });
  const receipt = await collectLiveAuthorizationReceipt(optionsFor(candidate));
  return { candidate, receipt };
}

function row(
  receipt: LiveAuthorizationReceipt,
  surface: string,
  transport: string,
  scenario: string,
): AuthorizationRow {
  const found = receipt.rows.find(
    (item) => item.surface === surface && item.transport === transport && item.scenario === scenario,
  );
  if (!found) throw new Error(`receipt has no ${surface}/${transport}/${scenario} row`);
  return found;
}

function assertion(target: AuthorizationRow, id: string) {
  return target.assertions.find((item) => item.id === id);
}

describe("live authorization receipt against a well-behaved candidate", () => {
  let candidate: FakeCandidate;
  let receipt: LiveAuthorizationReceipt;

  beforeAll(async () => {
    ({ candidate, receipt } = await mint());
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    await candidate?.close();
  });

  it("executes every authorization cell and passes it with an admissible transcript", () => {
    const summary = summarizeLiveAuthorizationReceipt(receipt).join("\n");
    expect(receipt.format).toBe(REALTIME_PREVIEW_EVIDENCE_FORMAT);
    expect(receipt.lane).toBe("live");
    expect(receipt.rows.map((item) => `${item.surface}/${item.transport}/${item.scenario}`).sort()).toEqual(
      AUTHORIZATION_SURFACES.flatMap(({ surface, transport }) =>
        AUTHORIZATION_SCENARIOS.map((scenario) => `${surface}/${transport}/${scenario}`),
      ).sort(),
    );
    for (const item of receipt.rows) {
      expect(item.result, summary).toBe("passed");
      expect(item.executed).toBe(true);
      expect(authorizationTranscriptReasons(item, receipt.workflow ?? {})).toEqual([]);
      expect(item).toMatchObject({
        serverRevision: FAKE_CANDIDATE_REVISION,
        serverImage: FAKE_CANDIDATE_IMAGE,
        sdkRevision: SDK_REVISION,
        environment: "fixture-two-tenant",
        runId: "1692",
        runAttempt: "1",
      });
      expect(item.authorization.tenantIds).toEqual(["tenant-a", "tenant-b"]);
    }
    expect(receipt.coverage).toMatchObject({ rows: 20, passed: 20, failed: [] });
  });

  it("binds every boundary row to the server-reported expiry or the revocation request", () => {
    for (const item of receipt.rows.filter(
      (entry) => entry.scenario === "token-expiry" || entry.scenario === "token-revocation",
    )) {
      const proof = item.authorization;
      const boundary = Date.parse((item.scenario === "token-revocation" ? proof.revokedAt : proof.expiresAt) as string);
      const terminated = Date.parse(proof.terminatedAt as string);
      expect(terminated).toBeGreaterThanOrEqual(boundary);
      expect(terminated).toBeLessThanOrEqual(boundary + ENFORCEMENT_BOUND_MS);
      expect(proof.terminationReason).toBe(item.transport === "odata" ? "unauthorized" : "authorization-ended");
      const outcome = proof.observations.find(
        (observation) =>
          observation.at === proof.terminatedAt && isAuthorizationTermination(observation.raw, item.transport),
      );
      expect(outcome, `${item.surface}/${item.transport}/${item.scenario}`).toBeDefined();
      if (item.scenario === "token-revocation") expect(terminated).toBeLessThan(Date.parse(proof.expiresAt as string));
    }
  });

  it("never retains an issued portal token, relay JWT or signing key", () => {
    const serialized = JSON.stringify(receipt);
    expect(candidate.issuedTokens.length).toBeGreaterThan(40);
    for (const token of candidate.issuedTokens) expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(ISSUER.signingKey);
    expect(serialized).not.toContain(ADMIN_API_KEY);
    expect(serialized).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./u);
  });

  it("does not mistake observation ids shared across tenants for a leak", () => {
    // The fake allocates observation ids per tenant, as the candidate does, so
    // across the whole run both tenants' observations reuse the same ids.
    const sensorRows = receipt.rows.filter((item) => item.surface === "sensorthings");
    const byId = new Map<number, Set<number>>();
    for (const item of sensorRows) {
      for (const observation of item.authorization.observations) {
        const frame = /^(?:event: observation\ndata: )?(\{.*\})\s*$/u.exec(observation.raw)?.[1];
        if (!frame) continue;
        const parsed = JSON.parse(frame) as { "@iot.id"?: number; result?: number };
        if (parsed["@iot.id"] === undefined || parsed.result === undefined) continue;
        byId.set(parsed["@iot.id"], (byId.get(parsed["@iot.id"]) ?? new Set()).add(parsed.result));
      }
    }
    expect([...byId.values()].some((results) => results.size > 1)).toBe(true);
    for (const item of sensorRows) {
      expect(assertion(item, "no-cross-tenant-payload")?.passed, `${item.transport}/${item.scenario}`).toBe(true);
    }
  });

  it("proves a tenantless credential is refused on feature surfaces and confined on SensorThings", () => {
    expect(
      assertion(row(receipt, "feature-stream", "sse", "tenant-isolation"), "invalid-credentials-rejected")?.detail,
    ).toMatch(/tenantless credential: 403/u);
    expect(
      assertion(row(receipt, "sensorthings", "websocket", "tenant-isolation"), "invalid-credentials-rejected")?.detail,
    ).toMatch(/tenantless credential: 101 admitted into the default tenant 'public' and confined to it/u);
  });
});

describe("live authorization receipt against a defective candidate", () => {
  let candidate: FakeCandidate;
  let receipt: LiveAuthorizationReceipt;

  beforeAll(async () => {
    ({ candidate, receipt } = await mint({
      leakForeignFeatures: true,
      featureWebSocketAbortsWithoutClose: true,
      odataConcealsUnauthorized: true,
      expireEarlyMs: 400,
    }));
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    await candidate?.close();
  });

  it("fails every feature-stream row that wrote a foreign change while a tenant-a subscription was open", () => {
    // Expiry, revocation and isolation write a tenant-b feature while tenant-a is
    // subscribed; scope-change only reconnects with tenant-a's cursor, and the
    // candidate's replay stays layer-scoped, so it has no leaked frame to catch.
    const summary = summarizeLiveAuthorizationReceipt(receipt).join("\n");
    for (const transport of ["sse", "websocket"]) {
      for (const scenario of ["token-expiry", "token-revocation", "tenant-isolation"]) {
        const item = row(receipt, "feature-stream", transport, scenario);
        expect(item.result, summary).toBe("failed");
        expect(assertion(item, "no-cross-tenant-payload"), summary).toMatchObject({ passed: false });
        expect(assertion(item, "no-cross-tenant-payload")?.detail).toMatch(/tenant-a observed rt-fixture-/u);
      }
    }
  });

  it("rejects a feature-stream WebSocket that drops without the typed close (honua-server#4776)", () => {
    for (const scenario of ["token-expiry", "token-revocation"]) {
      const item = row(receipt, "feature-stream", "websocket", scenario);
      expect(assertion(item, "old-credential-terminated")).toMatchObject({ passed: false });
      expect(item.authorization.terminatedAt).toBeUndefined();
    }
    expect(row(receipt, "sensorthings", "websocket", "token-revocation").result).toBe("passed");
  });

  it("rejects OData that answers an ended credential with 404 instead of 401 (honua-server#4778)", () => {
    for (const scenario of ["token-expiry", "token-revocation"]) {
      const item = row(receipt, "feature-stream", "odata", scenario);
      expect(assertion(item, "old-credential-terminated")).toMatchObject({ passed: false });
      expect(assertion(item, "old-credential-terminated")?.detail).toMatch(/last status 404/u);
    }
    expect(row(receipt, "feature-stream", "odata", "tenant-isolation").result).toBe("passed");
  });

  it("rejects termination before the advertised expiry (honua-server#4777) but keeps revocation proof", () => {
    const expiry = row(receipt, "sensorthings", "sse", "token-expiry");
    expect(assertion(expiry, "old-credential-terminated")).toMatchObject({ passed: false });
    expect(authorizationTranscriptReasons(expiry, receipt.workflow ?? {})).toContain(
      "termination exceeded the declared enforcement bound",
    );
    expect(row(receipt, "sensorthings", "sse", "token-revocation").result).toBe("passed");
    expect(receipt.coverage?.failed.length).toBeGreaterThan(0);
  });
});

describe("authorization transcript admissibility", () => {
  const window = { startedAt: "2026-09-13T09:59:00.000Z", completedAt: "2026-09-13T10:05:00.000Z" };
  const termination = 'event: status\ndata: {"status":"error","code":"authorization-ended"}\n\n';

  function revocationRow() {
    return {
      transport: "sse" as const,
      scenario: "token-revocation" as const,
      assertions: [
        "no-cross-tenant-payload",
        "invalid-credentials-rejected",
        "old-credential-terminated",
        "replacement-resume",
      ].map((id) => ({ id, passed: true })),
      authorization: {
        issuerFingerprint: `sha256:${"1".repeat(64)}`,
        tenantIds: ["tenant-a", "tenant-b"],
        resourceIds: ["tenant-a/layer/10", "tenant-b/layer/11"],
        mutationIds: ["marker-1", "marker-2"],
        issuedAt: "2026-09-13T10:00:00.000Z",
        expiresAt: "2026-09-13T10:01:00.000Z",
        revokedAt: "2026-09-13T10:00:10.000Z",
        terminatedAt: "2026-09-13T10:00:10.900Z",
        enforcementBoundMilliseconds: 5_000,
        terminationReason: "authorization-ended",
        observations: [
          { at: "2026-09-13T10:00:05.000Z", raw: 'event: feature-change\ndata: {"type":"feature-change"}\n\n' },
          { at: "2026-09-13T10:00:10.900Z", raw: termination },
        ],
      },
    };
  }

  it("admits a complete revocation transcript", () => {
    expect(authorizationTranscriptReasons(revocationRow(), window)).toEqual([]);
  });

  it.each([
    [
      "termination before the revocation",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.terminatedAt = "2026-09-13T10:00:09.500Z";
        r.authorization.observations[1] = { at: "2026-09-13T10:00:09.500Z", raw: termination };
      },
      "termination exceeded the declared enforcement bound",
    ],
    [
      "termination after the bound",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.terminatedAt = "2026-09-13T10:00:15.001Z";
        r.authorization.observations[1] = { at: "2026-09-13T10:00:15.001Z", raw: termination };
      },
      "termination exceeded the declared enforcement bound",
    ],
    [
      "revocation after expiry",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.expiresAt = "2026-09-13T10:00:09.000Z";
      },
      "revocation must occur during the token lifetime",
    ],
    [
      "a reason string inside a data payload",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.observations[1] = {
          at: "2026-09-13T10:00:10.900Z",
          raw: 'event: feature-change\ndata: {"code":"authorization-ended"}\n\n',
        };
      },
      "terminatedAt does not match a raw authorization outcome",
    ],
    [
      "a missing replacement-resume receipt",
      (r: ReturnType<typeof revocationRow>) => {
        r.assertions = r.assertions.filter((item) => item.id !== "replacement-resume");
      },
      "assertion receipts missing: replacement-resume",
    ],
    [
      "an observation outside the workflow",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.observations[0] = { at: "2026-09-13T09:58:00.000Z", raw: "event: heartbeat\ndata: {}\n\n" };
      },
      "an observation falls outside the live workflow window",
    ],
    [
      "no pre-boundary observation",
      (r: ReturnType<typeof revocationRow>) => {
        r.authorization.observations[0] = { at: "2026-09-13T10:00:12.000Z", raw: "event: heartbeat\ndata: {}\n\n" };
      },
      "the transcript must observe both sides of the boundary",
    ],
  ])("rejects %s", (_label, mutate, reason) => {
    const target = revocationRow();
    mutate(target);
    expect(authorizationTranscriptReasons(target, window)).toContain(reason);
  });

  it("decodes only typed transport outcomes as authorization termination", () => {
    expect(isAuthorizationTermination(termination, "sse")).toBe(true);
    expect(
      isAuthorizationTermination(
        'event: feature-change\ndata: {"status":"error","code":"authorization-ended"}\n\n',
        "sse",
      ),
    ).toBe(false);
    expect(isAuthorizationTermination('{"type":"close","code":1008,"reason":"authorization-ended"}', "websocket")).toBe(
      true,
    );
    expect(isAuthorizationTermination('{"type":"close","code":1006,"reason":""}', "websocket")).toBe(false);
    expect(isAuthorizationTermination('{"type":"close","code":1000,"reason":"authorization-ended"}', "websocket")).toBe(
      false,
    );
    expect(isAuthorizationTermination("HTTP/1.1 401 Unauthorized\r\n\r\n", "odata")).toBe(true);
    expect(isAuthorizationTermination('HTTP/1.1 404 Not Found\r\n\r\n{"status":401}', "odata")).toBe(false);
    expect(isAuthorizationTermination('HTTP/1.1 200 OK\r\n\r\n{"code":"authorization-ended"}', "odata")).toBe(false);
  });
});

describe("issuer and identity inputs", () => {
  it("mints an HS256 relay JWT the candidate can verify, with a unique jti per issuance", () => {
    const now = Date.parse("2026-09-13T10:00:00.000Z");
    const first = mintIssuerJwt(ISSUER, { subject: "reader-tenant-a", tenant: "tenant-a", roles: ["reader"], now });
    const second = mintIssuerJwt(ISSUER, { subject: "reader-tenant-a", tenant: "tenant-a", roles: ["reader"], now });
    const [header, payload, signature] = first.split(".");
    expect(createHmac("sha256", ISSUER.signingKey).update(`${header}.${payload}`).digest("base64url")).toBe(signature);
    const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));
    expect(claims).toMatchObject({
      iss: ISSUER.issuer,
      aud: ISSUER.audience,
      tenant_id: "tenant-a",
      roles: ["reader"],
      iat: 1789293600,
    });
    expect(second).not.toBe(first);
    const tenantless = mintIssuerJwt(ISSUER, { subject: "reader-tenantless", tenant: null, roles: ["reader"], now });
    expect(
      JSON.parse(Buffer.from(tenantless.split(".")[1] as string, "base64url").toString("utf8")),
    ).not.toHaveProperty("tenant_id");
  });

  it("fingerprints the issuer configuration without retaining the signing key", () => {
    const base = { issuer: ISSUER, referer: "https://fixture.invalid/", tokenExpirationMinutes: 1 };
    const fingerprint = issuerFingerprint(base);
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(issuerFingerprint(base)).toBe(fingerprint);
    expect(fingerprint).not.toContain(ISSUER.signingKey);
    expect(issuerFingerprint({ ...base, issuer: { ...ISSUER, signingKey: `${ISSUER.signingKey}x` } })).not.toBe(
      fingerprint,
    );
    expect(issuerFingerprint({ ...base, tokenExpirationMinutes: 5 })).not.toBe(fingerprint);
  });

  it("refuses mutable or incomplete candidate identities before any transport opens", () => {
    const env = {
      HONUA_REALTIME_CANDIDATE_BASE_URL: "http://127.0.0.1:18080/",
      HONUA_REALTIME_CANDIDATE_ADMIN_API_KEY: ADMIN_API_KEY,
      HONUA_REALTIME_CANDIDATE_REVISION: FAKE_CANDIDATE_REVISION,
      HONUA_REALTIME_CANDIDATE_IMAGE_DIGEST: FAKE_CANDIDATE_IMAGE,
      HONUA_REALTIME_CANDIDATE_ENVIRONMENT: "fixture-two-tenant",
      HONUA_REALTIME_ISSUER_REFERER: "https://fixture.invalid/",
      HONUA_REALTIME_ISSUER: ISSUER.issuer,
      HONUA_REALTIME_ISSUER_AUDIENCE: ISSUER.audience,
      HONUA_REALTIME_ISSUER_SIGNING_KEY: ISSUER.signingKey,
      HONUA_SAMPLE_SOURCE_REVISION: SDK_REVISION,
      GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      GITHUB_WORKFLOW: "Realtime Cross-Transport Conformance",
      GITHUB_RUN_ID: "1692",
      GITHUB_RUN_ATTEMPT: "1",
      HONUA_REALTIME_WORKFLOW_STARTED_AT: "2026-09-13T10:00:00.000Z",
    };
    expect(normalizeLiveAuthorizationEnv(env)).toMatchObject({
      baseUrl: "http://127.0.0.1:18080",
      tokenExpirationMinutes: 1,
    });
    expect(() =>
      normalizeLiveAuthorizationEnv({
        ...env,
        HONUA_REALTIME_CANDIDATE_IMAGE_DIGEST: "ghcr.io/honua-io/honua-server:nightly",
      }),
    ).toThrow(/immutable sha256 digest/u);
    expect(() => normalizeLiveAuthorizationEnv({ ...env, HONUA_REALTIME_ISSUER_CLOCK_SKEW_SECONDS: "300" })).toThrow(
      /zero clock skew/u,
    );
    expect(() => normalizeLiveAuthorizationEnv({ ...env, GITHUB_RUN_ID: "latest" })).toThrow(/GITHUB_RUN_ID/u);
    expect(() => normalizeLiveAuthorizationEnv({ ...env, HONUA_REALTIME_ISSUER_SIGNING_KEY: undefined })).toThrow(
      /SIGNING_KEY is required/u,
    );
  });

  it("refuses to emit a receipt that contains a credential", () => {
    expect(() =>
      assertNoRetainedCredentials({ rows: [{ raw: "token=0123456789abcdef" }] }, ["0123456789abcdef"]),
    ).toThrow(/leaked/u);
    expect(() => assertNoRetainedCredentials({ rows: [] }, ["0123456789abcdef"])).not.toThrow();
  });
});
