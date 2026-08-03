import { describe, expect, it } from "vitest";
import {
  assertCredentialFreeManifest,
  findManifestCredentialLeak,
  screenPersistedString,
} from "../src/offline/credential-screen.js";
import {
  type CreateOfflineRegionManifestInput,
  type HonuaOfflineEditQueueError,
  type HonuaOfflineRegionError,
  type OfflineRegionManifestV1,
  createMemoryOfflineEditQueue,
  createOfflineRegionManifest,
} from "../src/offline/index.js";

const encoder = new TextEncoder();
const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;

// Values that would only ever reach disk by accident. Kept distinctive so a
// non-echo assertion cannot pass by coincidence.
const ARCGIS_TOKEN = "K9zQeVeryDistinctiveArcgisTokenValue";
const AWS_SIGNATURE = "3f1cVeryDistinctiveAwsSignatureValue";

async function integrity(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function manifestInput(
  overrides: Partial<CreateOfflineRegionManifestInput> = {},
): Promise<CreateOfflineRegionManifestInput> {
  return {
    name: "North shore field area",
    sourceId: "incidents",
    endpoint: "https://example.test/FeatureServer/0",
    authorizationScopeFingerprint: "tenant:a/role:field",
    bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
    sourceVersion: "source-v3",
    schemaVersion: "schema-v7",
    planVersion: "plan-v2",
    observation: { state: "live", observedAt: "2026-07-10T10:00:00Z" },
    attribution: { osm: "© OpenStreetMap contributors" },
    resources: [{ id: "tile/1/0/0", kind: "tile" as const, byteLength: 3, integrity: await integrity("one") }],
    ...overrides,
  };
}

async function expectRejected(
  input: Partial<CreateOfflineRegionManifestInput>,
  path: string,
  secret: string,
): Promise<void> {
  let caught: unknown;
  try {
    await createOfflineRegionManifest(await manifestInput(input));
  } catch (error) {
    caught = error;
  }
  const failure = caught as HonuaOfflineRegionError;
  expect(failure).toBeInstanceOf(Error);
  expect(failure.code).toBe("invalid-manifest");
  expect(failure.path).toBe(path);
  // NFR-002: the message names the path and never repeats the rejected value.
  expect(failure.message).toContain(path);
  expect(failure.message).not.toContain(secret);
}

describe("offline persisted-string credential screening", () => {
  it("rejects credential-shaped identities, attribution values, and versions at manifest creation", async () => {
    await expectRejected({ sourceId: `incidents?token=${ARCGIS_TOKEN}` }, "sourceId", ARCGIS_TOKEN);
    await expectRejected({ sourceVersion: `source-v3&access_token=${ARCGIS_TOKEN}` }, "sourceVersion", ARCGIS_TOKEN);
    await expectRejected({ schemaVersion: `schema-v7;X-Api-Key=${ARCGIS_TOKEN}` }, "schemaVersion", ARCGIS_TOKEN);
    await expectRejected({ planVersion: `plan-v2#sig=${AWS_SIGNATURE}` }, "planVersion", AWS_SIGNATURE);
    await expectRejected({ name: `Field area ?apikey=${ARCGIS_TOKEN}` }, "name", ARCGIS_TOKEN);
    await expectRejected(
      { attribution: { osm: `Authorization: Bearer ${ARCGIS_TOKEN}` } },
      "attribution.osm",
      ARCGIS_TOKEN,
    );
    await expectRejected({ attribution: { "x-api-key": "© Someone" } }, "attribution id", "x-api-key");
    await expectRejected(
      {
        resources: [
          {
            id: `tiles/0/0/0?X-Amz-Signature=${AWS_SIGNATURE}`,
            kind: "tile" as const,
            byteLength: 3,
            integrity: await integrity("one"),
          },
        ],
      },
      "resources[0].id",
      AWS_SIGNATURE,
    );
    await expectRejected(
      {
        resources: [
          {
            id: "tile/1/0/0",
            kind: "tile" as const,
            byteLength: 3,
            integrity: await integrity("one"),
            contentType: `application/json;token=${ARCGIS_TOKEN}`,
          },
        ],
      },
      "resources[0].contentType",
      ARCGIS_TOKEN,
    );
    await expectRejected(
      {
        resources: [
          {
            id: "tile/1/0/0",
            kind: "tile" as const,
            byteLength: 3,
            integrity: await integrity("one"),
            planVersion: `plan-v2?signature=${AWS_SIGNATURE}`,
          },
        ],
      },
      "resources[0].planVersion",
      AWS_SIGNATURE,
    );
  });

  it("rejects a percent-encoded credential name that would otherwise decode after persistence", async () => {
    await expectRejected({ sourceId: `incidents%3Ftoken%3D${ARCGIS_TOKEN}` }, "sourceId", ARCGIS_TOKEN);
  });

  it("rejects URL-shaped identities carrying userinfo, a query, or a fragment", async () => {
    await expectRejected({ sourceId: "https://operator:hunter2@example.test/FeatureServer/0" }, "sourceId", "hunter2");
    await expectRejected({ sourceId: "https://example.test/FeatureServer/0?f=json" }, "sourceId", "f=json");
    await expectRejected({ sourceId: "https://example.test/FeatureServer/0#draft" }, "sourceId", "draft");
    await expectRejected(
      {
        resources: [
          { id: "tiles/0/0/0?f=pbf", kind: "tile" as const, byteLength: 3, integrity: await integrity("one") },
        ],
      },
      "resources[0].id",
      "f=pbf",
    );
    // Prose is not held to the relative-reference rule, only to the absolute-URL rule.
    await expect(
      createOfflineRegionManifest(await manifestInput({ name: "Field area @ HQ #2" })),
    ).resolves.toBeTruthy();
    await expectRejected({ name: "https://example.test/regions?f=json" }, "name", "f=json");
  });

  it("keeps ordinary identities, prose, and attribution text persistable", async () => {
    const created = await createOfflineRegionManifest(
      await manifestInput({
        name: "Mount Signature Overlook",
        sourceId: "honolulu-ops:0",
        attribution: { osm: "© OpenStreetMap contributors", noaa: "Data: NOAA, all rights reserved" },
        resources: [
          {
            id: "tiles/12/345/678.pbf",
            kind: "tile" as const,
            byteLength: 3,
            integrity: await integrity("one"),
            contentType: "application/vnd.mapbox-vector-tile",
          },
        ],
      }),
    );
    expect(created.name).toBe("Mount Signature Overlook");
    expect(created.source.id).toBe("honolulu-ops:0");
    expect(created.resources[0]?.contentType).toBe("application/vnd.mapbox-vector-tile");
  });

  it("screens identities more strictly than prose", () => {
    expect(screenPersistedString("token", "identity")).toBe("credential-shaped");
    expect(screenPersistedString("token", "label")).toBeUndefined();
    expect(screenPersistedString("Mount Signature", "identity")).toBe("credential-shaped");
    expect(screenPersistedString("Mount Signature", "label")).toBeUndefined();
    expect(screenPersistedString("region?token=x", "label")).toBe("credential-shaped");
    expect(screenPersistedString("tiles/0/0/0?f=json", "identity")).toBe("url-shaped");
    expect(screenPersistedString("tiles/0/0/0?f=json", "label")).toBeUndefined();
    expect(screenPersistedString("incidents", "identity")).toBeUndefined();
  });
});

describe("direct offline region store commits", () => {
  async function committable(): Promise<OfflineRegionManifestV1> {
    return createOfflineRegionManifest(await manifestInput());
  }

  it("accepts a manifest produced by the SDK", async () => {
    const manifest = await committable();
    expect(findManifestCredentialLeak(manifest)).toBeUndefined();
    expect(() => assertCredentialFreeManifest(manifest)).not.toThrow();
  });

  it("refuses a hand-built manifest carrying a credential-bearing endpoint", async () => {
    const base = await committable();
    const tampered = {
      ...base,
      source: {
        ...base.source,
        endpoint: `https://example.test/FeatureServer/0?token=${ARCGIS_TOKEN}`,
      },
    } as OfflineRegionManifestV1;
    expect(findManifestCredentialLeak(tampered)).toEqual({
      path: "source.endpoint",
      reason: "endpoint-not-normalized",
    });
    expect(() => assertCredentialFreeManifest(tampered)).toThrowError(/source\.endpoint/);
    try {
      assertCredentialFreeManifest(tampered);
    } catch (error) {
      const failure = error as HonuaOfflineRegionError;
      expect(failure.code).toBe("invalid-manifest");
      expect(failure.path).toBe("source.endpoint");
      expect(failure.message).not.toContain(ARCGIS_TOKEN);
    }
  });

  it("refuses a hand-built manifest carrying a credential-bearing identity", async () => {
    const base = await committable();
    const tampered = {
      ...base,
      resources: [{ ...base.resources[0], id: `tiles/0/0/0?X-Amz-Signature=${AWS_SIGNATURE}` }],
    } as OfflineRegionManifestV1;
    expect(findManifestCredentialLeak(tampered)).toEqual({
      path: "resources[0].id",
      reason: "credential-shaped",
    });
  });

  it("refuses a hand-built manifest whose source identity is a request URL", async () => {
    const base = await committable();
    const tampered = {
      ...base,
      source: { ...base.source, id: "https://example.test/FeatureServer/0#tiles" },
    } as OfflineRegionManifestV1;
    expect(findManifestCredentialLeak(tampered)).toEqual({ path: "source.id", reason: "url-shaped" });
  });
});

describe("durable edit queue identity screening", () => {
  async function expectQueueRejection(
    overrides: { readonly sourceId?: string; readonly idempotencyKey?: string },
    path: string,
    secret: string,
  ): Promise<void> {
    const queue = createMemoryOfflineEditQueue();
    let caught: unknown;
    try {
      await queue.enqueue({
        authorizationScopeDigest: AUTHORIZATION_SCOPE,
        sourceId: "incidents",
        idempotencyKey: "local-1",
        edit: { operation: "add", attributes: { status: "open" } },
        ...overrides,
      });
    } catch (error) {
      caught = error;
    }
    const failure = caught as HonuaOfflineEditQueueError;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("invalid-edit");
    expect(failure.path).toBe(path);
    expect(failure.message).toContain(path);
    expect(failure.message).not.toContain(secret);
  }

  it("rejects credential-shaped sourceId and idempotencyKey values", async () => {
    await expectQueueRejection({ sourceId: `incidents?token=${ARCGIS_TOKEN}` }, "sourceId", ARCGIS_TOKEN);
    await expectQueueRejection({ idempotencyKey: `local-1&sig=${AWS_SIGNATURE}` }, "idempotencyKey", AWS_SIGNATURE);
    await expectQueueRejection(
      { sourceId: "https://operator:hunter2@example.test/FeatureServer/0" },
      "sourceId",
      "hunter2",
    );
    await expectQueueRejection({ idempotencyKey: "mutations/17?f=json" }, "idempotencyKey", "f=json");
  });

  it("rejects a credential-shaped partition on list and claim", async () => {
    const queue = createMemoryOfflineEditQueue();
    await expect(
      queue.list({ authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: `incidents?token=${ARCGIS_TOKEN}` }),
    ).rejects.toThrowError(/options\.sourceId/);
    await expect(
      queue.claimReady({
        authorizationScopeDigest: AUTHORIZATION_SCOPE,
        sourceId: `incidents?token=${ARCGIS_TOKEN}`,
        workerId: "worker-1",
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrowError(/options\.sourceId/);
  });

  it("keeps ordinary queue identities enqueueable", async () => {
    const queue = createMemoryOfflineEditQueue();
    await expect(
      queue.enqueue({
        authorizationScopeDigest: AUTHORIZATION_SCOPE,
        sourceId: "honolulu-ops:0",
        idempotencyKey: "mutation-17",
        edit: { operation: "add", attributes: { status: "open" } },
      }),
    ).resolves.toMatchObject({ status: "enqueued" });
  });
});
