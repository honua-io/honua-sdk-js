/**
 * Pure unit tests for the integration-lane diagnostics helpers. These run
 * under the standard `npm test` lane (no live server) so the harness
 * shape is exercised on every PR — the live integration suite itself
 * runs in a separate workflow.
 *
 * @module
 */

import { describe, expect, it } from "vitest";
import { HonuaHttpError, HonuaTimeoutError } from "../src/index.js";
import {
  type DiagnosticsContext,
  MAX_BODY_EXCERPT_CHARS,
  createDiagnosticsInterceptor,
  formatFailureContext,
  runWithDiagnostics,
} from "./integration/diagnostics.js";

function context(): DiagnosticsContext {
  return {};
}

describe("integration diagnostics", () => {
  it("captures path and method from the before interceptor", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    interceptor.before?.({
      url: "http://server/example",
      path: "/example",
      method: "GET",
      init: {},
    });
    expect(ctx.lastPath).toBe("/example");
    expect(ctx.lastMethod).toBe("GET");
  });

  it("captures status and duration from the after interceptor", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    await interceptor.after?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      response: new Response("body", { status: 200 }),
      durationMs: 17.5,
    });
    expect(ctx.lastStatus).toBe(200);
    expect(ctx.lastDurationMs).toBe(17.5);
  });

  it("captures a JSON body excerpt for a 200 response so failed assertions carry the payload", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    const body = JSON.stringify({ features: [], exceededTransferLimit: false });
    await interceptor.after?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      response: new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      durationMs: 4,
    });
    expect(ctx.lastBodySummary).toBe(body);
  });

  it("records a metadata-only summary for binary success responses", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await interceptor.after?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      response: new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "5" },
      }),
      durationMs: 6,
    });
    expect(ctx.lastBodySummary).toContain("binary body");
    expect(ctx.lastBodySummary).toContain("image/png");
    expect(ctx.lastBodySummary).toContain("5 bytes");
  });

  it("reports an explicit empty-body marker on 204 responses", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    await interceptor.after?.({
      request: { url: "http://server/x", path: "/x", method: "DELETE", init: {} },
      response: new Response(null, { status: 204 }),
      durationMs: 1,
    });
    expect(ctx.lastBodySummary).toBe("(empty body)");
  });

  it("records an HttpError body summary on the error interceptor", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    await interceptor.error?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      error: new HonuaHttpError(404, "Not Found", { error: { code: 404, message: "missing" } }),
      durationMs: 3,
    });
    expect(ctx.lastStatus).toBe(404);
    expect(ctx.lastBodySummary).toContain("missing");
  });

  it("truncates long response bodies in the diagnostic block", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    const long = "x".repeat(MAX_BODY_EXCERPT_CHARS + 100);
    await interceptor.error?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      error: new HonuaHttpError(500, "Server error", long),
      durationMs: 1,
    });
    expect(ctx.lastBodySummary?.length).toBeLessThan(MAX_BODY_EXCERPT_CHARS + 80);
    expect(ctx.lastBodySummary).toContain("[truncated");
  });

  it("renders timeout errors with a synthetic status of 0", async () => {
    const ctx = context();
    const interceptor = createDiagnosticsInterceptor(ctx);
    await interceptor.error?.({
      request: { url: "http://server/x", path: "/x", method: "GET", init: {} },
      error: new HonuaTimeoutError(2000),
      durationMs: 2000,
    });
    expect(ctx.lastStatus).toBe(0);
    expect(ctx.lastBodySummary).toContain("timeout");
  });

  it("wraps exceptions with the diagnostic block via runWithDiagnostics", async () => {
    const ctx: DiagnosticsContext = {
      lastPath: "/places",
      lastMethod: "GET",
      lastStatus: 500,
      lastBodySummary: "internal error",
      lastDurationMs: 12.4,
    };
    await expect(
      runWithDiagnostics(ctx, "client.featureLayer().queryFeatures", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom[\s\S]*honua-integration[\s\S]*\/places[\s\S]*500/);
  });

  it("returns the success value untouched when no error is thrown", async () => {
    const ctx = context();
    const value = await runWithDiagnostics(ctx, "client.thing()", () => Promise.resolve(42));
    expect(value).toBe(42);
  });

  it("renders an empty diagnostic block when no request was observed", () => {
    const block = formatFailureContext("client.thing()", context());
    expect(block).toContain("(no request observed)");
    expect(block).toContain("(no response)");
  });
});
