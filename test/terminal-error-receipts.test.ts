import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeHonuaError } from "../src/core/error-envelope.js";
import { HonuaGrpcError, HonuaHttpError } from "../src/core/errors.js";
import { wrapConnectError } from "../src/core/grpc-adapter.js";
import { toGeoServicesError, toHttpError } from "../src/core/request-pipeline.js";

interface FixtureFailure {
  id: string;
  httpStatus: number;
  geoServicesCode: number;
  grpcStatus: { name: string; number: number };
  kind: string;
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  detail: string;
  errors?: readonly Record<string, unknown>[];
  authenticationRequired?: { httpStatus: number; kind: string; code: string };
}

interface Fixture {
  expectedCellCount: number;
  sdkPaths: readonly { id: string }[];
  failureClasses: readonly FixtureFailure[];
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/terminal-error-receipts.v1.json", import.meta.url), "utf8"),
) as Fixture;

function headersFor(failure: FixtureFailure): Headers {
  const headers = new Headers({
    "X-Correlation-ID": `corr-${failure.id}`,
    "X-Test-Metadata": failure.id,
    "Set-Cookie": "secret=must-not-surface",
  });
  if (failure.retryAfterSeconds !== undefined) headers.set("Retry-After", String(failure.retryAfterSeconds));
  return headers;
}

function assertReceipt(error: HonuaHttpError | Error, failure: FixtureFailure, transportStatus?: number): void {
  if (!("receipt" in error) || !error.receipt) throw new Error("missing terminal receipt");
  expect(error.receipt.transportStatus).toBe(transportStatus);
  expect(error.receipt.kind).toBe(failure.kind);
  expect(error.receipt.code).toBe(failure.code);
  expect(error.receipt.retryable).toBe(failure.retryable);
  expect(error.receipt.retryAfterMs).toBe(
    failure.retryAfterSeconds === undefined ? undefined : failure.retryAfterSeconds * 1_000,
  );
  expect(error.receipt.correlationId).toBe(`corr-${failure.id}`);
  expect(error.receipt.fieldErrors).toHaveLength(failure.errors?.length ?? 0);
}

describe("terminal error receipt matrix", () => {
  it("locks the shared denominator at exactly 40 cells", () => {
    expect(fixture.sdkPaths).toHaveLength(8);
    expect(fixture.failureClasses).toHaveLength(5);
    expect(fixture.sdkPaths.length * fixture.failureClasses.length).toBe(fixture.expectedCellCount);
  });

  for (const failure of fixture.failureClasses) {
    it(`preserves JS HTTP ${failure.id}`, () => {
      const error = toHttpError(
        failure.httpStatus,
        {
          status: failure.httpStatus,
          kind: failure.kind,
          code: failure.code,
          detail: failure.detail,
          retryable: failure.retryable,
          retryAfterSeconds: failure.retryAfterSeconds,
          correlationId: `corr-${failure.id}`,
          errors: failure.errors,
        },
        headersFor(failure),
      );
      assertReceipt(error, failure, failure.httpStatus);
      expect(error.receipt.protocolCode).toBeUndefined();
      expect(error.receipt.protocolMetadata.initial["set-cookie"]).toBeUndefined();
      const serialized = serializeHonuaError(error);
      expect(serialized.receipt).toEqual(error.receipt);
      expect(serialized).not.toHaveProperty("body");
    });

    it(`preserves JS GeoServices ${failure.id}`, () => {
      const error = toGeoServicesError(
        200,
        {
          error: {
            code: failure.geoServicesCode,
            message: failure.detail,
            kind: failure.kind,
            machineCode: failure.code,
            retryable: failure.retryable,
            retryAfterSeconds: failure.retryAfterSeconds,
            correlationId: `corr-${failure.id}`,
            errors: failure.errors,
          },
        },
        headersFor(failure),
      );
      expect(error).toBeInstanceOf(HonuaHttpError);
      assertReceipt(error!, failure, 200);
      expect(error!.statusCode).toBe(failure.geoServicesCode);
      expect(error!.receipt.protocolCode).toBe(failure.geoServicesCode);
    });

    it(`preserves JS gRPC ${failure.id}`, () => {
      const error = Object.assign(new Error(failure.detail), {
        code: failure.grpcStatus.number,
        rawMessage: failure.detail,
        headers: new Headers({ "X-Test-Initial": failure.id }),
        metadata: new Headers({
          "X-Correlation-ID": `corr-${failure.id}`,
          "Honua-Error-Kind": failure.kind,
          "Honua-Error-Code": failure.code,
          "Honua-Error-Retryable": String(failure.retryable),
          ...(failure.retryAfterSeconds === undefined ? {} : { "Retry-After": String(failure.retryAfterSeconds) }),
          ...(failure.errors === undefined ? {} : { "Honua-Error-Details": JSON.stringify(failure.errors) }),
        }),
      });
      const wrapped = wrapConnectError(error);
      if (!(wrapped instanceof HonuaGrpcError)) throw new Error("Connect error was not normalized");
      assertReceipt(wrapped, failure);
      expect(wrapped.receipt.protocolCode).toBe(failure.grpcStatus.number);
      expect(wrapped.receipt.protocolMetadata).toMatchObject({
        initial: { "x-test-initial": [failure.id] },
        trailing: { "honua-error-code": [failure.code] },
      });
    });
  }

  it("keeps authentication required distinct from authorization denied", () => {
    const authz = fixture.failureClasses[0];
    if (!authz?.authenticationRequired) throw new Error("fixture is missing authenticationRequired");
    const authentication = toHttpError(authz.authenticationRequired.httpStatus, {
      kind: authz.authenticationRequired.kind,
      code: authz.authenticationRequired.code,
    });
    const authorization = toHttpError(authz.httpStatus, { kind: authz.kind, code: authz.code });
    expect(authentication.receipt.kind).toBe("authentication");
    expect(authorization.receipt.kind).toBe("authorization");
  });
});
