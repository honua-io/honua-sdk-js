import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_SCHEMA_BYTES,
  DIAGNOSTIC_SCHEMA_SHA256,
  HonuaDiagnosticSafetyError,
  assertDiagnosticBundle,
  createDiagnosticBundle,
  normalizeDiagnosticPath,
  replayDiagnosticBundle,
  sanitizeDiagnosticBody,
  validateDiagnosticBundle,
  verifyDiagnosticSchemaBytes,
} from "../src/diagnostics/index.js";

const consent = { redactionAcknowledged: true, shareWithSupport: true };

describe("diagnostic bundle v1", () => {
  it("byte-pins the deployed canonical schema", async () => {
    const bytes = await readFile("schemas/diagnostic-bundle.v1.json");
    expect(bytes.byteLength).toBe(DIAGNOSTIC_SCHEMA_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DIAGNOSTIC_SCHEMA_SHA256);
    expect(() => verifyDiagnosticSchemaBytes(bytes)).not.toThrow();
    expect(() => verifyDiagnosticSchemaBytes(new Uint8Array([1, 2, 3]))).toThrow("byte count");
  });

  it("drops URL credentials, sensitive query values, cookies, auth, and non-allowlisted headers", () => {
    const bundle = createDiagnosticBundle({
      contentClassification: "secret-suspected",
      consent,
      exchanges: [
        {
          method: "post",
          url: "https://alice:password@example.test/api/items/123456?token=top-secret&where=owner%3Dalice",
          requestHeaders: {
            authorization: "Bearer raw-access-token",
            cookie: "session=raw-cookie",
            "x-not-allowed": "raw-custom-secret",
            "content-type": "application/json",
            "x-request-id": "req-123",
          },
          responseHeaders: { "set-cookie": "raw-response-cookie", "x-correlation-id": "corr-123" },
          requestBody: {
            username: "person@example.test",
            password: "raw-password",
            nested: { apiKey: "raw-api-key", note: "Bearer raw-bearer" },
          },
          responseBody: "token=raw-form-token&name=person%40example.test",
          mediaType: "application/x-www-form-urlencoded",
        },
      ],
    });

    expect(bundle.envelopes[0].normalizedPath).toBe("/api/items/{value}?where={value}");
    expect(bundle.envelopes[0].requestHeaders).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "x-request-id", value: "req-123" },
    ]);
    expect(bundle.envelopes[0].responseHeaders).toEqual([{ name: "x-correlation-id", value: "corr-123" }]);
    const serialized = JSON.stringify(bundle);
    for (const secret of [
      "top-secret",
      "raw-access-token",
      "raw-cookie",
      "raw-custom-secret",
      "raw-response-cookie",
      "raw-password",
      "raw-api-key",
      "raw-bearer",
      "raw-form-token",
      "person@example.test",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(validateDiagnosticBundle(bundle)).toEqual({ valid: true, issues: [] });
  });

  it("redacts free text and preserves original byte hash while bounding previews", () => {
    const raw = `Authorization%253A%2520Bearer%2520abc.def.ghi person@example.test sk_1234567890 pk_live_12345678 rk_test_12345678 ghp_abcdefghij gho_12345678901234567890 xoxb-123456789 AIza12345678901234567890 glpat-1234567890 aws_secret_access_key=short-secret ${"x".repeat(20_000)}`;
    const preview = sanitizeDiagnosticBody(raw, { mediaType: "text/plain", previewBytes: 128 });
    expect(preview?.preview).not.toContain("abc.def.ghi");
    expect(preview?.preview).not.toContain("person@example.test");
    expect(preview?.preview).not.toContain("sk_1234567890");
    expect(preview?.preview).not.toContain("ghp_abcdefghij");
    expect(preview?.preview).not.toContain("pk_live_12345678");
    expect(preview?.preview).not.toContain("rk_test_12345678");
    expect(preview?.preview).not.toContain("gho_12345678901234567890");
    expect(preview?.preview).not.toContain("xoxb-123456789");
    expect(preview?.preview).not.toContain("AIza12345678901234567890");
    expect(preview?.preview).not.toContain("glpat-1234567890");
    expect(preview?.preview).not.toContain("short-secret");
    expect(preview?.originalByteSize).toBe(new TextEncoder().encode(raw).byteLength);
    expect(preview?.contentSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(preview?.redactionApplied).toBe(true);
    expect(preview?.truncated).toBe(true);
    expect(new TextEncoder().encode(preview?.preview).byteLength).toBeLessThanOrEqual(128);
  });

  it("requires explicit consent/classification and validates the fail-closed schema", () => {
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "invalid" as "public",
        consent,
        exchanges: [{ method: "GET", url: "https://example.test/api/v1/services" }],
      }),
    ).toThrow(HonuaDiagnosticSafetyError);
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "public",
        consent: {} as typeof consent,
        exchanges: [{ method: "GET", url: "https://example.test/api/v1/services" }],
      }),
    ).toThrow("Explicit");

    const invalid = {
      schemaVersion: "1.0",
      contentClassification: "public",
      consent,
      envelopes: [{ method: "GET", normalizedPath: "/api", rawBody: "forbidden" }],
    };
    const result = validateDiagnosticBundle(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ path: "$.envelopes[0].rawBody", message: "is not allowed" });
    expect(() => assertDiagnosticBundle(invalid)).toThrow("pinned v1 schema");
  });

  it("guarantees direct emitter output is schema-valid and rejects non-body overages", () => {
    const valid = createDiagnosticBundle({
      bundleId: "bundle-1",
      contentClassification: "public",
      consent: { ...consent, grantedBy: "reviewer" },
      exchanges: [{ method: "GET", url: "https://example.test/api", statusCode: 200, mediaType: "application/json" }],
    });
    expect(validateDiagnosticBundle(valid)).toEqual({ valid: true, issues: [] });
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "public",
        consent,
        exchanges: [{ method: "GET", url: "https://example.test/api", statusCode: 900 }],
      }),
    ).toThrow("statusCode");
    expect(() =>
      createDiagnosticBundle({
        bundleId: "x".repeat(65),
        contentClassification: "public",
        consent,
        exchanges: [{ method: "GET", url: "https://example.test/api" }],
      }),
    ).toThrow("bundle id");
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "public",
        consent: { ...consent, grantedBy: "x".repeat(257) },
        exchanges: [{ method: "GET", url: "https://example.test/api" }],
      }),
    ).toThrow("consent identity");
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "public",
        consent,
        previewBytes: 8193,
        exchanges: [{ method: "GET", url: "https://example.test/api" }],
      }),
    ).toThrow("1 to 8192");
    expect(() =>
      createDiagnosticBundle({
        contentClassification: "public",
        consent,
        exchanges: [{ method: "GET", url: "https://example.test/api", mediaType: `text/plain${"x".repeat(247)}` }],
      }),
    ).toThrow("media type");
  });

  it("emits only a strict subset of support intake's header allowlist", () => {
    const bundle = createDiagnosticBundle({
      contentClassification: "public",
      consent,
      exchanges: [
        {
          method: "GET",
          url: "https://example.test/api/v1/services",
          requestHeaders: {
            accept: "application/json",
            "content-type": "application/json; boundary=short-secret",
            "content-length": "42",
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "x-request-id": "request-1",
            "x-correlation-id": "correlation-1",
            server: "must-drop",
            "x-honua-version": "must-drop",
            "accept-language": "support-allows-but-sdk-omits",
            "honua-public": "support-prefix-allows-but-sdk-omits",
          },
        },
      ],
    });
    expect(bundle.envelopes[0].requestHeaders?.map((header) => header.name)).toEqual([
      "accept",
      "content-length",
      "content-type",
      "traceparent",
      "x-correlation-id",
      "x-request-id",
    ]);
    expect(bundle.envelopes[0].requestHeaders).toContainEqual({ name: "content-type", value: "application/json" });
    expect(JSON.stringify(bundle)).not.toContain("short-secret");
  });

  it("normalizes identifiers and refuses traversal, non-HTTP, and malformed paths", () => {
    expect(normalizeDiagnosticPath("https://example.test/items/550e8400-e29b-41d4-a716-446655440000?q=secret")).toBe(
      "/items/{value}?q={value}",
    );
    expect(normalizeDiagnosticPath("https://example.test/users/alice/profile?person%40example.test=value")).toBe(
      "/{value}/{value}/{value}?{parameter}={value}",
    );
    expect(normalizeDiagnosticPath("https://user:short@example.test/api/v1/services?api_key=short")).toBe(
      "/api/v1/services",
    );
    expect(() => normalizeDiagnosticPath("file:///etc/passwd")).toThrow("HTTP or HTTPS");
    expect(() => normalizeDiagnosticPath("https://example.test/a/%2e%2e/b")).toThrow(/unsafe path|malformed/);
    expect(() => normalizeDiagnosticPath("https://example.test/a\\b")).toThrow("malformed");
  });

  it("replays one bounded read without forwarding captured headers or query values", async () => {
    const bundle = createDiagnosticBundle({
      contentClassification: "internal",
      consent,
      exchanges: [{ method: "GET", url: "https://old.example.test/api/v1/services?limit=10" }],
    });
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://new.example.test/api/v1/services");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
      return new Response(JSON.stringify({ services: [{ id: "public" }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-1" },
      });
    });
    const replayed = await replayDiagnosticBundle({ bundle, baseUrl: "https://new.example.test", fetchFn });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(replayed.envelopes).toHaveLength(1);
    expect(replayed.envelopes[0]).toMatchObject({ method: "GET", normalizedPath: "/api/v1/services", statusCode: 200 });
    expect(validateDiagnosticBundle(replayed).valid).toBe(true);
  });

  it("refuses mutation, subscription, unsafe paths, credentials, and hash drift before fetch", async () => {
    const fetchFn = vi.fn();
    const base = createDiagnosticBundle({
      contentClassification: "internal",
      consent,
      exchanges: [{ method: "POST", url: "https://example.test/api/v1/applyEdits" }],
    });
    await expect(replayDiagnosticBundle({ bundle: base, baseUrl: "https://example.test", fetchFn })).rejects.toThrow(
      "GET and HEAD",
    );
    const subscription = structuredClone(base);
    subscription.envelopes[0] = { method: "GET", normalizedPath: "/api/v1/subscribe" };
    await expect(
      replayDiagnosticBundle({ bundle: subscription, baseUrl: "https://example.test", fetchFn }),
    ).rejects.toThrow("mutation-, subscription-");
    const traversal = structuredClone(base);
    traversal.envelopes[0] = { method: "GET", normalizedPath: "/api/%2e%2e/admin" };
    await expect(
      replayDiagnosticBundle({ bundle: traversal, baseUrl: "https://example.test", fetchFn }),
    ).rejects.toThrow("mutation-, subscription-");
    const credential = structuredClone(base);
    credential.envelopes[0] = {
      method: "GET",
      normalizedPath: "/api",
      requestHeaders: [{ name: "authorization", value: "Bearer raw" }],
    };
    await expect(
      replayDiagnosticBundle({ bundle: credential, baseUrl: "https://example.test", fetchFn }),
    ).rejects.toThrow("credential material");
    const hashDrift = structuredClone(base);
    hashDrift.envelopes[0] = {
      method: "GET",
      normalizedPath: "/api",
      responseBody: {
        preview: "changed",
        originalByteSize: 7,
        contentSha256: "0".repeat(64),
        redactionApplied: false,
        truncated: false,
      },
    };
    await expect(
      replayDiagnosticBundle({ bundle: hashDrift, baseUrl: "https://example.test", fetchFn }),
    ).rejects.toThrow("integrity metadata");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("honors an already-aborted replay signal", async () => {
    const bundle = createDiagnosticBundle({
      contentClassification: "public",
      consent,
      exchanges: [{ method: "GET", url: "https://example.test/api" }],
    });
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const fetchFn = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response();
    });
    await expect(
      replayDiagnosticBundle({ bundle, baseUrl: "https://example.test", signal: controller.signal, fetchFn }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
