import { describe, expect, it } from "vitest";

import { HONUA_ERROR_RUNTIME_CLASSIFICATIONS } from "../src/core/error-classifications.js";
import { HonuaExplorationContextError, HonuaWfsExceptionError } from "../src/core/errors.js";
import { HonuaJobFailedError } from "../src/core/ogc-processes.js";
import { DEFAULT_RETRYABLE_GRPC_CODES } from "../src/core/request-pipeline.js";
import { HonuaWmsCapabilitiesParseError } from "../src/core/wms-capabilities.js";
import { HonuaWmtsCapabilitiesParseError } from "../src/core/wmts-capabilities.js";
import {
  HONUA_ERROR_CODE_REGISTRY,
  HONUA_ERROR_KIND,
  HonuaAbortError,
  HonuaAuthError,
  HonuaCapabilityNotSupportedError,
  HonuaDiscoveryError,
  type HonuaErrorOptions,
  HonuaGeometryError,
  HonuaGrpcError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaSdkError,
  HonuaTimeoutError,
  isHonuaError,
  isHonuaErrorCode,
  serializeHonuaError,
} from "../src/index.js";
import { HonuaAutomaticMapLibreIntegrationError } from "../src/map/automatic-mount-integration.js";
import { HonuaAutomaticMapLibreStrategyError } from "../src/map/automatic-source-strategy.js";
import { HonuaDataToMapBridgeError } from "../src/map/data-to-map-bridge.js";
import { HonuaMapLibreRasterStrategyError } from "../src/map/raster-source-strategy.js";
import { HonuaMapLibreSourceAdapterError } from "../src/map/source-to-maplibre.js";
import { HonuaTemporalPlaybackError } from "../src/map/temporal-playback.js";
import { HonuaQueryPlanExecutionError, HonuaQueryPlanningError } from "../src/query-planner/types.js";
import { HonuaRealtimeResumeError } from "../src/realtime/index.js";
import type { ResumableRealtimeReasonCode } from "../src/realtime/index.js";
import { HonuaMapPackageError } from "../src/runtime/errors.js";
import { QueryTileServerResponseError } from "../src/runtime/query-tiles.js";
import { HonuaRuntimeDiagnosticError } from "../src/runtime/style-interactions.js";

describe("tagged SDK error envelope", () => {
  it("recognizes core, discovery, query, map, runtime, and realtime public errors", () => {
    const errors = [
      new HonuaNetworkError("offline", new TypeError("fetch failed")),
      new HonuaDiscoveryError("invalid-endpoint", "bad endpoint"),
      new HonuaGeometryError("malformed-geometry", "bad geometry"),
      new HonuaQueryPlanningError("invalid-query", "bad query"),
      new HonuaQueryPlanExecutionError("invalid-plan", "bad plan"),
      new HonuaMapLibreSourceAdapterError("invalid-option", "bad option"),
      new HonuaDataToMapBridgeError("invalid-option", "bad option"),
      new HonuaAutomaticMapLibreStrategyError("no-eligible-strategy", "none"),
      new HonuaMapLibreRasterStrategyError("unsupported-strategy", "none"),
      new HonuaAutomaticMapLibreIntegrationError("invalid-target", "bad target"),
      new HonuaTemporalPlaybackError("bad extent"),
      new HonuaMapPackageError("bad package", { stage: "validate" }),
      new HonuaRuntimeDiagnosticError("bad style", []),
      new QueryTileServerResponseError({ status: 400, url: "https://example.test/tiles", message: "bad tile" }),
      new HonuaRealtimeResumeError("invalid-checkpoint", "bad checkpoint"),
    ];

    for (const error of errors) {
      expect(isHonuaError(error), error.name).toBe(true);
      expect(error.kind).toBe(HONUA_ERROR_KIND);
      expect(isHonuaErrorCode(error.sdkCode)).toBe(true);
      expect(HONUA_ERROR_CODE_REGISTRY[error.sdkCode].domain).toBe(error.domain);
    }
  });

  it("preserves documented legacy code and instanceof contracts", () => {
    const grpc = new HonuaGrpcError(14, "unavailable");
    const discovery = new HonuaDiscoveryError("invalid-endpoint", "bad endpoint");
    const planning = new HonuaQueryPlanningError("invalid-query", "bad query");
    const map = new HonuaMapLibreSourceAdapterError("disposed", "disposed");
    const realtime = new HonuaRealtimeResumeError("sequence-gap", "gap");

    expect(grpc.code).toBe(14);
    expect(grpc.sdkCode).toBe("core.grpc.transient");
    expect(grpc).toBeInstanceOf(HonuaGrpcError);
    expect(discovery.code).toBe("invalid-endpoint");
    expect(discovery.sdkCode).toBe("discovery.invalid-endpoint");
    expect(discovery).toBeInstanceOf(HonuaDiscoveryError);
    expect(planning.code).toBe("invalid-query");
    expect(planning.sdkCode).toBe("query.planning.invalid-query");
    expect(planning).toBeInstanceOf(HonuaQueryPlanningError);
    expect(map.code).toBe("disposed");
    expect(map.sdkCode).toBe("map.source-adapter.disposed");
    expect(map).toBeInstanceOf(HonuaMapLibreSourceAdapterError);
    expect(realtime.code).toBe("sequence-gap");
    expect(realtime.sdkCode).toBe("realtime.sequence.gap");
    expect(realtime).toBeInstanceOf(HonuaRealtimeResumeError);
  });

  it("preserves legacy fields, causes, and instanceof behavior for every migrated class family", () => {
    const cause = new Error("local cause");
    const body = { error: "local body" };
    const detail = { sourceId: "parcels" };
    const diagnostics = [{ code: "invalid-style", severity: "error" as const, message: "invalid" }];
    const instances = [
      [new HonuaHttpError(503, "unavailable", body, { cause }), HonuaHttpError],
      [new HonuaTimeoutError(500, { cause }), HonuaTimeoutError],
      [new HonuaNetworkError("offline", cause), HonuaNetworkError],
      [new HonuaAbortError("cancelled", { cause }), HonuaAbortError],
      [new HonuaGrpcError(14, "unavailable", detail, { cause }), HonuaGrpcError],
      [new HonuaAuthError("refresh_failed", "refresh failed", { cause }), HonuaAuthError],
      [new HonuaCapabilityNotSupportedError("query", "wmts", "tiles", { cause }), HonuaCapabilityNotSupportedError],
      [new HonuaDiscoveryError("invalid-endpoint", "invalid", detail, { cause }), HonuaDiscoveryError],
      [new HonuaExplorationContextError("disposed", "disposed", { cause }), HonuaExplorationContextError],
      [new HonuaWfsExceptionError("InvalidParameterValue", "bad filter", "filter", { cause }), HonuaWfsExceptionError],
      [new HonuaJobFailedError("failed", "failed", "JobFailed", detail), HonuaJobFailedError],
      [new HonuaWmsCapabilitiesParseError("invalid WMS"), HonuaWmsCapabilitiesParseError],
      [new HonuaWmtsCapabilitiesParseError("invalid WMTS"), HonuaWmtsCapabilitiesParseError],
      [new HonuaQueryPlanningError("invalid-query", "invalid", { cause }), HonuaQueryPlanningError],
      [new HonuaQueryPlanExecutionError("invalid-plan", "invalid", { cause }), HonuaQueryPlanExecutionError],
      [
        new HonuaMapLibreSourceAdapterError("invalid-option", "invalid", detail, { cause }),
        HonuaMapLibreSourceAdapterError,
      ],
      [new HonuaDataToMapBridgeError("invalid-option", "invalid", detail, { cause }), HonuaDataToMapBridgeError],
      [
        new HonuaAutomaticMapLibreStrategyError("no-eligible-strategy", "none", detail, { cause }),
        HonuaAutomaticMapLibreStrategyError,
      ],
      [
        new HonuaMapLibreRasterStrategyError("unsupported-strategy", "none", detail, { cause }),
        HonuaMapLibreRasterStrategyError,
      ],
      [
        new HonuaAutomaticMapLibreIntegrationError("invalid-target", "invalid", detail),
        HonuaAutomaticMapLibreIntegrationError,
      ],
      [new HonuaTemporalPlaybackError("invalid"), HonuaTemporalPlaybackError],
      [new HonuaMapPackageError("failed", { stage: "load", detail, cause }), HonuaMapPackageError],
      [new HonuaRuntimeDiagnosticError("invalid", diagnostics, cause), HonuaRuntimeDiagnosticError],
      [
        new QueryTileServerResponseError({
          status: 503,
          url: "https://example.test/tiles",
          message: "unavailable",
          response: {
            contractVersion: 1,
            error: { code: "unavailable", message: "try later", status: 503 },
          },
          body,
          validators: { etag: '"v1"' },
        }),
        QueryTileServerResponseError,
      ],
      [new HonuaRealtimeResumeError("checkpoint-load-failed", "load failed", { cause }), HonuaRealtimeResumeError],
      [new HonuaGeometryError("malformed-geometry", "invalid geometry", detail, { cause }), HonuaGeometryError],
    ] as const;

    for (const [error, ErrorClass] of instances) {
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
    }

    expect((instances[0][0] as HonuaHttpError).body).toBe(body);
    expect((instances[0][0] as HonuaHttpError).cause).toBe(cause);
    expect((instances[4][0] as HonuaGrpcError).code).toBe(14);
    expect((instances[4][0] as HonuaGrpcError).details).toBe(detail);
    expect((instances[5][0] as HonuaAuthError).code).toBe("refresh_failed");
    expect((instances[7][0] as HonuaDiscoveryError).code).toBe("invalid-endpoint");
    expect((instances[7][0] as HonuaDiscoveryError).detail).toBe(detail);
    expect((instances[8][0] as HonuaExplorationContextError).code).toBe("disposed");
    expect((instances[13][0] as HonuaQueryPlanningError).code).toBe("invalid-query");
    expect((instances[15][0] as HonuaMapLibreSourceAdapterError).code).toBe("invalid-option");
    expect((instances[16][0] as HonuaDataToMapBridgeError).code).toBe("invalid-option");
    expect((instances[17][0] as HonuaAutomaticMapLibreStrategyError).code).toBe("no-eligible-strategy");
    expect((instances[18][0] as HonuaMapLibreRasterStrategyError).code).toBe("unsupported-strategy");
    expect((instances[19][0] as HonuaAutomaticMapLibreIntegrationError).code).toBe("invalid-target");
    expect((instances[21][0] as HonuaMapPackageError).stage).toBe("load");
    expect((instances[21][0] as HonuaMapPackageError).detail).toBe(detail);
    expect((instances[21][0] as HonuaMapPackageError).cause).toBe(cause);
    expect((instances[22][0] as HonuaRuntimeDiagnosticError).diagnostics).toBe(diagnostics);
    expect((instances[22][0] as HonuaRuntimeDiagnosticError).cause).toBe(cause);
    expect((instances[23][0] as QueryTileServerResponseError).body).toBe(body);
    expect((instances[23][0] as QueryTileServerResponseError).status).toBe(503);
    expect((instances[24][0] as HonuaRealtimeResumeError).code).toBe("checkpoint-load-failed");
    expect((instances[24][0] as HonuaRealtimeResumeError).cause).toBe(cause);
    expect((instances[25][0] as HonuaGeometryError).code).toBe("malformed-geometry");
    expect((instances[25][0] as HonuaGeometryError).detail).toBe(detail);
    expect((instances[25][0] as HonuaGeometryError).cause).toBe(cause);
    expect(Object.hasOwn(new HonuaMapLibreSourceAdapterError("disposed", "disposed"), "cause")).toBe(false);
    expect(Object.hasOwn(new HonuaAuthError("interaction_required", "sign in"), "cause")).toBe(true);
  });

  it("maps geometry reasons to exact safe envelope classifications", () => {
    const cause = new TypeError("geometry-cause-secret");
    const cases = [
      ["unknown-geometry", "core.geometry.unknown-geometry"],
      ["malformed-geometry", "core.geometry.malformed-geometry"],
    ] as const;

    for (const [code, sdkCode] of cases) {
      const error = new HonuaGeometryError(
        code,
        "invalid geometry with message-secret",
        { coordinateCount: 7, authorization: "Bearer detail-secret" },
        { cause, context: { requestStage: "classify" } },
      );

      expect(error).toMatchObject({
        code,
        sdkCode,
        domain: "core",
        category: "validation",
        retryable: false,
        context: {
          coordinateCount: 7,
          authorization: "[REDACTED]",
          requestStage: "classify",
        },
      });
      expect(error.cause).toBe(cause);
      expect(serializeHonuaError(error)).toMatchObject({
        code: sdkCode,
        domain: "core",
        category: "validation",
        retryable: false,
        cause: { name: "TypeError" },
      });
      const json = JSON.stringify(error);
      expect(json).not.toContain("message-secret");
      expect(json).not.toContain("detail-secret");
      expect(json).not.toContain("geometry-cause-secret");
    }
  });

  it("keeps retryability and cancellation/capability/validation/internal categories stable", () => {
    const cancelled = new HonuaAbortError();
    const capability = new HonuaCapabilityNotSupportedError("query", "wmts");
    const validation = new HonuaQueryPlanningError("invalid-query", "bad query");
    const internal = new HonuaMapLibreSourceAdapterError("map-mutation-failed", "renderer rejected mutation");
    const retryableHttp = new HonuaHttpError(503, "unavailable", null);
    const rejectedHttp = new HonuaHttpError(400, "invalid", null);

    expect([cancelled.category, cancelled.retryable]).toEqual(["cancellation", false]);
    expect([capability.category, capability.retryable]).toEqual(["capability", false]);
    expect([validation.category, validation.retryable]).toEqual(["validation", false]);
    expect([internal.category, internal.retryable]).toEqual(["internal", false]);
    expect([retryableHttp.sdkCode, retryableHttp.retryable]).toEqual(["core.http.transient", true]);
    expect([rejectedHttp.sdkCode, rejectedHttp.retryable]).toEqual(["core.http.rejected", false]);
  });

  it("keeps gRPC envelope retryability aligned with the request pipeline", () => {
    for (let code = 0; code <= 16; code += 1) {
      const error = new HonuaGrpcError(code, `gRPC status ${code}`);
      const retryable = DEFAULT_RETRYABLE_GRPC_CODES.has(code);
      expect(error.retryable, `gRPC status ${code}`).toBe(retryable);
      expect(error.sdkCode, `gRPC status ${code}`).toBe(retryable ? "core.grpc.transient" : "core.grpc.rejected");
    }
  });

  it("classifies every required realtime recovery boundary without changing the legacy reason code", () => {
    const cases = [
      ["cancelled", "realtime.cancelled", "cancellation", false],
      ["transport-gap", "realtime.transport.reconnectable", "network", true],
      ["invalid-checkpoint", "realtime.checkpoint.invalid", "validation", false],
      ["sequence-gap", "realtime.sequence.gap", "protocol", true],
      ["delivery-failed", "realtime.protocol.terminal", "protocol", false],
    ] as const;

    for (const [reason, sdkCode, category, retryable] of cases) {
      const error = new HonuaRealtimeResumeError(reason, `local ${reason} detail`);
      expect(error.code).toBe(reason);
      expect(error.sdkCode).toBe(sdkCode);
      expect(error.domain).toBe("realtime");
      expect(error.category).toBe(category);
      expect(error.retryable).toBe(retryable);
      expect(error.name).toBe("HonuaRealtimeResumeError");
      expect(error).toBeInstanceOf(HonuaRealtimeResumeError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "realtime", category, retryable });
    }
  });

  it("serializes realtime failures without messages, authorization, tokens, payloads, or filter values", () => {
    const cause = {
      authorization: "Bearer realtime-header-secret",
      resumeToken: "resume-token-secret",
      cursor: "cursor-secret",
      payload: { feature: { owner: "payload-owner-secret" } },
      filter: "owner = 'filter-owner-secret'",
    };
    const error = new HonuaRealtimeResumeError("delivery-failed", "terminal stream failure for message-owner-secret", {
      cause,
    });

    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ reasonCode: "delivery-failed" });
    const json = JSON.stringify(error);
    for (const secret of [
      "realtime-header-secret",
      "resume-token-secret",
      "cursor-secret",
      "payload-owner-secret",
      "filter-owner-secret",
      "message-owner-secret",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(JSON.parse(json)).toMatchObject({
      name: "HonuaRealtimeResumeError",
      domain: "realtime",
      code: "realtime.protocol.terminal",
      context: { reasonCode: "delivery-failed" },
      cause: { name: "object" },
    });
  });

  it("keeps unregistered runtime realtime reasons local and projects only a fixed safe context reason", () => {
    const rawString = "resumeToken=runtime-string-secret";
    let coercionAttempted = false;
    const rawObject = {
      payload: "runtime-object-secret",
      [Symbol.toPrimitive]() {
        coercionAttempted = true;
        throw new Error("runtime-object-coercion-secret");
      },
    };
    const stringError = new HonuaRealtimeResumeError(rawString as ResumableRealtimeReasonCode, "local failure");
    const objectError = new HonuaRealtimeResumeError(
      rawObject as unknown as ResumableRealtimeReasonCode,
      "local failure",
    );

    expect(stringError.code).toBe(rawString);
    expect(objectError.code).toBe(rawObject);
    expect(coercionAttempted).toBe(false);
    for (const error of [stringError, objectError]) {
      expect(error).toMatchObject({
        sdkCode: "realtime.protocol.terminal",
        context: { reasonCode: "invalid-event" },
      });
      const json = JSON.stringify(error);
      for (const secret of ["runtime-string-secret", "runtime-object-secret", "runtime-object-coercion-secret"]) {
        expect(json).not.toContain(secret);
      }
    }
  });

  it("serializes identifiers and redacted context while preserving the raw cause on the instance", () => {
    const cause = new TypeError("Bearer cause-secret cursor=raw-cause-cursor");
    const error = new HonuaDiscoveryError(
      "invalid-endpoint",
      "message includes owner = 'Jane Secret' and is deliberately not serialized",
      {
        authorization: "Bearer header-secret",
        headers: { Authorization: "Bearer nested-secret", "x-safe": "kept" },
        cursor: "raw-cursor",
        resumeToken: "raw-resume-token",
        awsAccessKeyId: "direct-aws-access-key",
        googleAccessId: "direct-google-access-id",
        where: "owner = 'Jane Secret'",
        filter: "token = 'filter-secret'",
        query: { owner: "query-secret" },
        sql: "select * from secrets",
        url: "https://user:pass@example.test/items?access_token=url-secret&cursor=url-cursor&X-Amz-Credential=amz-credential&X-Amz-Security-Token=amz-token&X-Amz-Signature=amz-signature&AWSAccessKeyId=legacy-aws-access-key&GoogleAccessId=legacy-google-access-id&page[cursor]=page-bracket-cursor&page_cursor=page-underscore-cursor&limit=10#fragment",
        note: "Bearer free-text-secret",
      },
      {
        cause,
        operationId: "connect:inspect-1",
        requestId: "request-42",
      },
    );

    expect(error.cause).toBe(cause);
    const serialized = serializeHonuaError(error);
    const json = JSON.stringify(serialized);
    for (const secret of [
      "header-secret",
      "nested-secret",
      "raw-cursor",
      "raw-resume-token",
      "direct-aws-access-key",
      "direct-google-access-id",
      "Jane Secret",
      "filter-secret",
      "query-secret",
      "select *",
      "url-secret",
      "url-cursor",
      "amz-credential",
      "amz-token",
      "amz-signature",
      "legacy-aws-access-key",
      "legacy-google-access-id",
      "page-bracket-cursor",
      "page-underscore-cursor",
      "free-text-secret",
      "cause-secret",
      "raw-cause-cursor",
      "user:pass",
      "#fragment",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(serialized).toMatchObject({
      code: "discovery.invalid-endpoint",
      domain: "discovery",
      operationId: "connect:inspect-1",
      requestId: "request-42",
      cause: { name: "TypeError" },
    });
    expect(serialized).not.toHaveProperty("message");
    expect(serialized).not.toHaveProperty("stack");
    expect(serialized.context.authorization).toBe("[REDACTED]");
    expect(serialized.context.cursor).toBe("[REDACTED]");
    expect(serialized.context.awsAccessKeyId).toBe("[REDACTED]");
    expect(serialized.context.googleAccessId).toBe("[REDACTED]");
    expect(serialized.context.where).toBe("[REDACTED]");
    expect(serialized.context.url).toContain("limit=10");
  });

  it("does not invoke accessors or preserve prototype-manipulation keys", () => {
    let getterInvoked = false;
    const capturedAt = new Date("2026-07-13T00:00:00.000Z");
    Object.defineProperties(capturedAt, {
      toISOString: {
        value: () => {
          throw new Error("hostile override");
        },
      },
      valueOf: {
        value: () => {
          throw new Error("hostile override");
        },
      },
    });
    const context = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"safe":"value"}',
    ) as Record<string, unknown>;
    context.capturedAt = capturedAt;
    const values = ["safe"];
    Object.defineProperty(values, "0", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "Bearer array-getter-secret";
      },
    });
    context.values = values;
    Object.defineProperty(context, "authorization", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "Bearer getter-secret";
      },
    });

    const error = new HonuaDiscoveryError("invalid-endpoint", "bad", context);
    const serialized = serializeHonuaError(error);

    expect(getterInvoked).toBe(false);
    expect(Object.getPrototypeOf(error.context)).toBeNull();
    expect(Object.hasOwn(error.context, "__proto__")).toBe(false);
    expect(Object.hasOwn(error.context, "constructor")).toBe(false);
    expect(error.context.__redacted_keys__).toBe(2);
    expect(error.context.authorization).toBe("[REDACTED]");
    expect(error.context.capturedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(error.context.values).toEqual(["[ACCESSOR]"]);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect(JSON.stringify(serialized)).not.toContain("getter-secret");
  });

  it("projects only own data error options across core, structured, map, and runtime constructors", () => {
    let accessorInvoked = false;
    const cause = new TypeError("local cause");
    const options: HonuaErrorOptions & Record<string, unknown> = {
      cause: undefined,
      operationId: "operation-42",
      requestId: "request-42",
      context: { safe: "kept" },
    };
    Object.defineProperty(options, "unrelated", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        throw new Error("unrelated options accessor must not run");
      },
    });

    const errors = [
      new HonuaAbortError("aborted", options),
      new HonuaDiscoveryError("invalid-endpoint", "invalid", undefined, options),
      new HonuaGeometryError("malformed-geometry", "invalid", undefined, options),
      new HonuaHttpError(503, "unavailable", undefined, options),
      new HonuaMapLibreSourceAdapterError("map-mutation-failed", "failed", undefined, options),
      new HonuaRealtimeResumeError("invalid-event", "invalid", options),
      new HonuaNetworkError("offline", cause, options),
      new HonuaRuntimeDiagnosticError("invalid", [], cause, options),
    ];

    expect(accessorInvoked).toBe(false);
    for (const error of errors) {
      expect(error.operationId).toBe("operation-42");
      expect(error.requestId).toBe("request-42");
    }
    for (const error of [...errors.slice(0, 5), ...errors.slice(6)]) {
      expect(error.context).toMatchObject({ safe: "kept" });
    }
    expect(errors[5]?.context).toEqual({ reasonCode: "invalid-event" });
    for (const error of errors.slice(0, 6)) expect(Object.hasOwn(error, "cause")).toBe(true);
    expect(errors[6]?.cause).toBe(cause);
    expect(errors[7]?.cause).toBe(cause);

    const accessorOptions = Object.create(null) as Record<string, unknown>;
    for (const key of ["cause", "operationId", "requestId", "context"] as const) {
      Object.defineProperty(accessorOptions, key, {
        enumerable: true,
        get() {
          accessorInvoked = true;
          throw new Error(`${key} accessor must not run`);
        },
      });
    }
    const ignored = new HonuaAbortError("aborted", accessorOptions as HonuaErrorOptions);
    expect(accessorInvoked).toBe(false);
    expect(Object.hasOwn(ignored, "cause")).toBe(false);
    expect(ignored.operationId).toBeUndefined();
    expect(ignored.requestId).toBeUndefined();
    expect(ignored.context).toEqual({});
  });

  it("rejects spoofed cross-realm envelopes whose registry classification was altered", () => {
    const serialized = serializeHonuaError(new HonuaAbortError());
    const tagged = {
      ...serialized,
      sdkCode: serialized.code,
      context: Object.create(null),
    };
    delete (tagged as { code?: string }).code;

    expect(isHonuaError(tagged)).toBe(true);
    expect(isHonuaError({ ...tagged, retryable: true })).toBe(false);
    expect(isHonuaError({ ...tagged, category: "internal" })).toBe(false);
    expect(isHonuaError({ ...tagged, sdkCode: "unknown.code" })).toBe(false);
    expect(isHonuaError({ ...tagged, context: [] })).toBe(false);
  });

  it("does not invoke hostile guard getters or serialize custom error names", () => {
    let getterInvoked = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "kind", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return HONUA_ERROR_KIND;
      },
    });
    expect(isHonuaError(hostile)).toBe(false);
    expect(getterInvoked).toBe(false);

    const revoked = Proxy.revocable(Object.create(null), {});
    revoked.revoke();
    expect(() => isHonuaError(revoked.proxy)).not.toThrow();
    expect(isHonuaError(revoked.proxy)).toBe(false);

    const tagged = Object.assign(Object.create(null), {
      kind: HONUA_ERROR_KIND,
      name: "HonuaAbortError",
      domain: "core",
      sdkCode: "core.cancelled",
      category: "cancellation",
      retryable: false,
      context: Object.create(null),
    }) as Record<string, unknown>;
    for (const field of ["cause", "operationId", "requestId"] as const) {
      Object.defineProperty(tagged, field, {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error(`${field} getter must not run`);
        },
      });
    }
    expect(isHonuaError(tagged)).toBe(true);
    if (!isHonuaError(tagged)) throw new Error("expected tagged error");
    expect(() => serializeHonuaError(tagged)).not.toThrow();
    expect(getterInvoked).toBe(false);

    const cause = new TypeError("secret cause");
    Object.defineProperty(cause, "name", { configurable: true, value: "CauseCredentialSecret" });
    const error = new HonuaNetworkError("secret outer message", cause);
    Object.defineProperty(error, "name", { configurable: true, value: "OuterCredentialSecret" });
    const serialized = serializeHonuaError(error);
    expect(serialized.name).toBe("Error");
    expect(serialized.cause?.name).toBe("Error");
    expect(JSON.stringify(serialized)).not.toContain("CredentialSecret");
  });

  it("exports an immutable code registry", () => {
    expect(Object.isFrozen(HONUA_ERROR_CODE_REGISTRY)).toBe(true);
    const original = HONUA_ERROR_CODE_REGISTRY["core.timeout"];
    expect(Reflect.set(HONUA_ERROR_CODE_REGISTRY, "core.timeout", HONUA_ERROR_CODE_REGISTRY["core.network"])).toBe(
      false,
    );
    expect(HONUA_ERROR_CODE_REGISTRY["core.timeout"]).toBe(original);
  });

  it("keeps the compact runtime classifications in exact canonical registry parity", () => {
    expect(Object.isFrozen(HONUA_ERROR_RUNTIME_CLASSIFICATIONS)).toBe(true);
    expect(Object.keys(HONUA_ERROR_RUNTIME_CLASSIFICATIONS)).toEqual(Object.keys(HONUA_ERROR_CODE_REGISTRY));

    for (const code of Object.keys(HONUA_ERROR_CODE_REGISTRY) as (keyof typeof HONUA_ERROR_CODE_REGISTRY)[]) {
      const descriptor = HONUA_ERROR_CODE_REGISTRY[code];
      const classification = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[code];
      expect(classification, code).toEqual([descriptor.domain, descriptor.category, descriptor.retryable]);
      expect(Object.isFrozen(classification), code).toBe(true);
      expect(classification, code).toHaveLength(3);
    }
  });
});
