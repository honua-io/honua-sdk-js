import { describe, expect, it } from "vitest";
import {
  HONUA_ERROR_CODE_REGISTRY,
  type HonuaErrorCategory,
  type HonuaErrorCode,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaSdkError,
  HonuaTimeoutError,
  isHonuaError,
  sanitizeHonuaErrorContext,
  serializeHonuaError,
} from "../src/index.js";
import { HonuaOfflineRegionError, type OfflineRegionErrorCode } from "../src/offline/index.js";
import {
  HonuaReplicaSyncError,
  type ReplicaSyncErrorCode,
  isHonuaReplicaSyncError,
  isUnsupportedReplicaSyncError,
} from "../src/replica-sync/index.js";

type ClassificationCase<TCode extends string> = readonly [
  code: TCode,
  sdkCode: HonuaErrorCode,
  category: HonuaErrorCategory,
  retryable: boolean,
];

const REGION_CLASSIFICATIONS = [
  ["invalid-manifest", "offline.region.validation", "validation", false],
  ["resource-limit-exceeded", "offline.region.validation", "validation", false],
  ["quota-exceeded", "offline.region.quota", "validation", false],
  ["expired", "offline.region.validation", "validation", false],
  ["integrity-mismatch", "offline.region.integrity", "protocol", false],
  ["aborted", "offline.cancelled", "cancellation", false],
  ["resource-load-failed", "offline.transport.failure", "network", false],
  ["inventory-changed", "offline.storage.concurrent", "internal", true],
  ["store-failed", "offline.storage.failure", "internal", false],
] as const satisfies readonly ClassificationCase<OfflineRegionErrorCode>[];

const REPLICA_CLASSIFICATIONS = [
  ["unsupported-sync", "offline.replica-sync.capability", "capability", false],
  ["unsupported-conflict-review", "offline.replica-sync.capability", "capability", false],
  ["unsupported-conflict-resolution", "offline.replica-sync.capability", "capability", false],
  ["replica-not-found", "offline.replica-sync.validation", "validation", false],
  ["conflict-not-found", "offline.replica-sync.validation", "validation", false],
  ["replica-expired", "offline.replica-sync.validation", "validation", false],
  ["conflict-already-resolved", "offline.replica-sync.validation", "validation", false],
  ["merge-required", "offline.replica-sync.validation", "validation", false],
  ["permission-denied", "offline.replica-sync.permission-denied", "authentication", false],
  ["transport-failure", "offline.transport.failure", "network", false],
] as const satisfies readonly ClassificationCase<ReplicaSyncErrorCode>[];

describe("offline tagged SDK errors", () => {
  it("classifies every offline region legacy code without changing its local contract", () => {
    for (const [code, sdkCode, category, retryable] of REGION_CLASSIFICATIONS) {
      const error = new HonuaOfflineRegionError(code, `local ${code} detail`);

      expect(error.code).toBe(code);
      expect(error.sdkCode).toBe(sdkCode);
      expect(error.domain).toBe("offline");
      expect(error.category).toBe(category);
      expect(error.retryable).toBe(retryable);
      expect(error.name).toBe("HonuaOfflineRegionError");
      expect(error).toBeInstanceOf(HonuaOfflineRegionError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "offline", category, retryable });
    }
  });

  it("marks transport failures transient only for tagged retryable network or timeout causes", () => {
    const transientCauses = [
      new HonuaNetworkError("offline", new Error("socket closed")),
      new HonuaTimeoutError(5_000),
    ];
    for (const cause of transientCauses) {
      for (const error of [
        new HonuaOfflineRegionError("resource-load-failed", "load failed", { cause }),
        new HonuaReplicaSyncError("transport-failure", "sync failed", { cause }),
      ]) {
        expect(error).toMatchObject({
          sdkCode: "offline.transport.transient",
          category: "network",
          retryable: true,
        });
      }
    }

    const retryableProtocolCause = new HonuaHttpError(503, "unavailable", undefined);
    const permanentCauses: readonly unknown[] = [undefined, new Error("caller bug"), retryableProtocolCause];
    for (const cause of permanentCauses) {
      for (const error of [
        new HonuaOfflineRegionError("resource-load-failed", "load failed", { cause }),
        new HonuaReplicaSyncError("transport-failure", "sync failed", { cause }),
      ]) {
        expect(error).toMatchObject({
          sdkCode: "offline.transport.failure",
          category: "network",
          retryable: false,
        });
      }
    }
    expect(retryableProtocolCause.retryable).toBe(true);
    expect(retryableProtocolCause.category).toBe("protocol");
  });

  it("classifies every replica synchronization legacy code without changing its local guards", () => {
    for (const [code, sdkCode, category, retryable] of REPLICA_CLASSIFICATIONS) {
      const error = new HonuaReplicaSyncError(code, `local ${code} detail`);

      expect(error.code).toBe(code);
      expect(error.sdkCode).toBe(sdkCode);
      expect(error.domain).toBe("offline");
      expect(error.category).toBe(category);
      expect(error.retryable).toBe(retryable);
      expect(error.name).toBe("HonuaReplicaSyncError");
      expect(error).toBeInstanceOf(HonuaReplicaSyncError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(isHonuaReplicaSyncError(error)).toBe(true);
      expect(isUnsupportedReplicaSyncError(error)).toBe(code.startsWith("unsupported-"));
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "offline", category, retryable });
    }
  });

  it("retains raw causes and legacy offline detail fields only on the local instance", () => {
    const cause = new Error("local storage adapter detail");
    const region = new HonuaOfflineRegionError("integrity-mismatch", "local integrity detail", {
      cause,
      resourceId: "tile/4/3/2",
      path: "resources[0].integrity",
    });
    const details = { conflictId: "conflict-17", status: "pending" };
    const replica = new HonuaReplicaSyncError("merge-required", "local merge detail", { cause, details });

    expect(region.cause).toBe(cause);
    expect(region.resourceId).toBe("tile/4/3/2");
    expect(region.path).toBe("resources[0].integrity");
    expect(replica.cause).toBe(cause);
    expect(replica.details).toBe(details);
    expect(Object.hasOwn(new HonuaOfflineRegionError("expired", "expired"), "cause")).toBe(false);
    expect(Object.hasOwn(new HonuaReplicaSyncError("replica-expired", "expired"), "cause")).toBe(false);
  });

  it("serializes region failures without cached payloads, credentials, URLs, filters, or storage paths", () => {
    const resourceId =
      "https://cache-user:cache-password@example.test/features?access_token=resource-token&filter=owner-secret";
    const storagePath = "/home/field-user/.cache/honua/owner-secret.sqlite?token=path-token";
    const cause = {
      authorization: "Bearer region-header-secret",
      cachedFeaturePayload: { owner: "cached-owner-secret" },
      replicaToken: "region-replica-token",
      cursor: "region-sync-cursor",
      signedUrl: "https://example.test/cache?X-Amz-Signature=region-signature",
      filter: "owner = 'region-filter-secret'",
      localStoragePath: storagePath,
    };
    const error = new HonuaOfflineRegionError("integrity-mismatch", "integrity mismatch for message-owner-secret", {
      cause,
      resourceId,
      path: storagePath,
    });

    expect(error.cause).toBe(cause);
    expect(error.resourceId).toBe(resourceId);
    expect(error.path).toBe(storagePath);
    expect(error.context).toEqual({ reasonCode: "integrity-mismatch" });
    const serialized = serializeHonuaError(error);
    const json = JSON.stringify(error);
    for (const secret of [
      "cache-user",
      "cache-password",
      "resource-token",
      "owner-secret",
      "path-token",
      "region-header-secret",
      "cached-owner-secret",
      "region-replica-token",
      "region-sync-cursor",
      "region-signature",
      "region-filter-secret",
      "field-user",
      "message-owner-secret",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(serialized).toMatchObject({
      name: "HonuaOfflineRegionError",
      domain: "offline",
      code: "offline.region.integrity",
      category: "protocol",
      retryable: false,
      context: { reasonCode: "integrity-mismatch" },
      cause: { name: "object" },
    });
    expect(serialized).not.toHaveProperty("resourceId");
    expect(serialized).not.toHaveProperty("path");
  });

  it("serializes replica failures without conflict payloads, sync tokens, signed URLs, filters, or paths", () => {
    const details = {
      cachedFeaturePayload: {
        attributes: { owner: "replica-feature-secret" },
        geometry: { coordinates: [1, 2] },
      },
      replicaToken: "replica-token-secret",
      resumeToken: "replica-resume-secret",
      cursor: "replica-cursor-secret",
      authorization: "Bearer replica-header-secret",
      url: "https://replica-user:replica-pass@example.test/sync?sig=replica-signature&where=owner-secret",
      filter: "owner = 'replica-filter-secret'",
      localStoragePath: "C:\\Users\\field-user\\AppData\\Local\\Honua\\replica.db",
    };
    const cause = new Error("transport response contained replica-cause-secret");
    const error = new HonuaReplicaSyncError("transport-failure", "sync failed for replica-message-secret", {
      cause,
      details,
    });

    expect(error.cause).toBe(cause);
    expect(error.details).toBe(details);
    expect(error.context).toEqual({ reasonCode: "transport-failure" });
    const serialized = serializeHonuaError(error);
    const json = JSON.stringify(error);
    for (const secret of [
      "replica-feature-secret",
      "replica-token-secret",
      "replica-resume-secret",
      "replica-cursor-secret",
      "replica-header-secret",
      "replica-user",
      "replica-pass",
      "replica-signature",
      "owner-secret",
      "replica-filter-secret",
      "field-user",
      "replica-cause-secret",
      "replica-message-secret",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(serialized).toMatchObject({
      name: "HonuaReplicaSyncError",
      domain: "offline",
      code: "offline.transport.failure",
      category: "network",
      retryable: false,
      context: { reasonCode: "transport-failure" },
      cause: { name: "Error" },
    });
    expect(serialized).not.toHaveProperty("details");
  });

  it("redacts storage locators at the common context boundary", () => {
    const context = sanitizeHonuaErrorContext({
      localStoragePath: "/home/field-user/.cache/honua/replica.db",
      storageLocation: "file:///var/lib/honua/cache.sqlite",
      cacheFilePath: "C:\\Users\\field-user\\AppData\\Local\\Honua\\cache.db",
      fileUrl: "file:///Users/field-user/Library/Caches/Honua/cache.db",
      manifestPath: "resources[0].integrity",
      profileUrl: "https://example.test/profiles/alice?view=public",
      profileUri: "urn:honua:profile:alice",
    });

    expect(context).toEqual({
      localStoragePath: "[REDACTED]",
      storageLocation: "[REDACTED]",
      cacheFilePath: "[REDACTED]",
      fileUrl: "[REDACTED]",
      manifestPath: "resources[0].integrity",
      profileUrl: "https://example.test/profiles/alice?view=public",
      profileUri: "urn:honua:profile:alice",
    });
    expect(JSON.stringify(context)).not.toContain("field-user");
  });

  it("serializes hostile and revoked Proxy causes through a fixed fail-closed projection", () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile descriptor secret");
      },
      getPrototypeOf() {
        throw new Error("hostile prototype secret");
      },
    });
    const revoked = Proxy.revocable(Object.create(null) as object, {});
    revoked.revoke();

    for (const cause of [hostile, revoked.proxy]) {
      const errors = [
        new HonuaOfflineRegionError("resource-load-failed", "local region message secret", { cause }),
        new HonuaReplicaSyncError("transport-failure", "local replica message secret", { cause }),
      ];
      for (const error of errors) {
        expect(error).toMatchObject({ sdkCode: "offline.transport.failure", retryable: false });
        expect(() => serializeHonuaError(error)).not.toThrow();
        expect(serializeHonuaError(error).cause).toEqual({ name: "Error" });
        const json = JSON.stringify(error);
        expect(json).not.toContain("secret");
      }
    }
  });

  it("fails closed for unregistered runtime reason strings and objects without coercion", () => {
    const rawString = "resumeToken=offline-runtime-string-secret";
    let coercionAttempted = false;
    const rawObject = {
      cachedFeaturePayload: "offline-runtime-object-secret",
      [Symbol.toPrimitive]() {
        coercionAttempted = true;
        throw new Error("offline-runtime-coercion-secret");
      },
    };
    const errors = [
      new HonuaOfflineRegionError(rawString as OfflineRegionErrorCode, "local region failure"),
      new HonuaOfflineRegionError(rawObject as unknown as OfflineRegionErrorCode, "local region failure"),
      new HonuaReplicaSyncError(rawString as ReplicaSyncErrorCode, "local sync failure"),
      new HonuaReplicaSyncError(rawObject as unknown as ReplicaSyncErrorCode, "local sync failure"),
    ];

    expect(errors[0]?.code).toBe(rawString);
    expect(errors[1]?.code).toBe(rawObject);
    expect(errors[2]?.code).toBe(rawString);
    expect(errors[3]?.code).toBe(rawObject);
    expect(coercionAttempted).toBe(false);
    expect(errors.map((error) => error.sdkCode)).toEqual([
      "offline.region.validation",
      "offline.region.validation",
      "offline.replica-sync.validation",
      "offline.replica-sync.validation",
    ]);
    for (const error of errors) {
      expect(error.context).toEqual({ reasonCode: "invalid-error-code" });
      expect(isHonuaError(error)).toBe(true);
      const json = JSON.stringify(error);
      for (const secret of [
        "offline-runtime-string-secret",
        "offline-runtime-object-secret",
        "offline-runtime-coercion-secret",
      ]) {
        expect(json).not.toContain(secret);
      }
    }
    expect(coercionAttempted).toBe(false);
  });
});
