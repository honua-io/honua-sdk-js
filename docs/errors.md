# Error reference

The Honua JS SDK exposes a small, named error hierarchy from `@honua/sdk-js`. Every
error thrown by the SDK is an instance of one of the classes below, plus the
runtime-type guard `isHonuaError(error)` for ergonomic narrowing in `catch`
blocks. Use them to gate retry / refresh / surface-to-user decisions instead of
parsing message strings.

## At-a-glance table

| Class | Source | When it fires | Recover by |
|-------|--------|---------------|------------|
| `HonuaHttpError` | Any REST call | The server returned a non-2xx status with a parsed error envelope (4xx or 5xx). | Branch on `.statusCode`: `401`/`403` → refresh credentials or surface to user; `404` → treat as missing; `409` → conflict, refetch and retry; `429` → respect `Retry-After`; `5xx` → use the SDK's `retry` option or back off and retry idempotent calls. |
| `HonuaTimeoutError` | Any REST call | The `timeoutMs` configured on the client elapsed before the response arrived. | Increase `timeoutMs` per-call (the per-request `AbortSignal` is independent), or surface a "server slow" indicator. The request is idempotent-safe to retry. |
| `HonuaNetworkError` | Any REST call | The transport itself failed (`fetch` rejected) — DNS, TLS, offline, or upstream connection reset. | Inspect `.cause` if present; back off and retry. For browsers, this is also the most common error to render as "Check your connection." |
| `HonuaAbortError` | Any REST call | The caller's `AbortSignal` was aborted (or the SDK aborted on timeout — see `HonuaTimeoutError` for that case). | Do **not** retry. The caller asked to stop. Treat as a successful cancellation. |
| `HonuaGrpcError` | `transport: "grpc-web"` only | A gRPC-Web call returned a non-OK `Code`. | Branch on `.code` (Connect/`google.rpc.Code`): `UNAUTHENTICATED` → refresh credentials, `PERMISSION_DENIED` → surface; `UNAVAILABLE` → retry with backoff; `DEADLINE_EXCEEDED` → increase deadline or retry; `INVALID_ARGUMENT` → fix the call site. |
| `HonuaCapabilityNotSupportedError` | `Source.query` / `Source.applyEdits` / etc. | Under the default `capabilityPolicy: "strict"`, the active source does not support the requested operation (e.g. `query()` on a `wmts` source). | Either downgrade the request (drop the unsupported clause), fall back to `Source.protocol(...)` for raw protocol access, or set `capabilityPolicy: "degraded"` on `createDataset` to coerce best-effort behavior with a `degraded` reason in the `Result`. |
| `HonuaExplorationContextError` | `@honua/sdk-js/exploration` | An exploration intent referenced a missing slice / view, or the snapshot is incompatible with the active context schema. | Surface to user (UI bug) or migrate the saved snapshot. Do not retry. |
| `HonuaWfsExceptionError` | `wfs` adapter | The WFS server returned a `<ows:ExceptionReport>`. The original `exceptionCode`, `locator`, and `exceptionText` are preserved on the instance. | Branch on `.exceptionCode` (`InvalidParameterValue`, `OperationNotSupported`, `MissingParameterValue`, etc.). Most are caller bugs; surface to user. |
| `HonuaJobFailedError` | OGC Processes / geoprocessing job polling | An async job (`IJobRun.results()`) reached a non-success terminal state (`failed` / `dismissed`). The terminal `.status`, `.errorCode`, and `.details` are preserved on the instance. | Branch on `.status` / `.errorCode`. Usually a server-side or input error; surface to user. Do not blindly retry. |

## Narrowing in `catch`

Prefer the `isHonuaError` guard so unrelated exceptions (e.g. caller TypeErrors
in callbacks) propagate normally:

```ts
import { HonuaHttpError, HonuaTimeoutError, HonuaCapabilityNotSupportedError, isHonuaError } from "@honua/sdk-js";

try {
  await dataset.source("parcels")!.queryAll({ where: "1=1" });
} catch (error) {
  if (!isHonuaError(error)) throw error;

  if (error instanceof HonuaCapabilityNotSupportedError) {
    // expected for capability misses — fall back to a narrower query
    return fallbackQuery();
  }
  if (error instanceof HonuaHttpError && error.statusCode === 401) {
    await refreshCredentials();
    return retry();
  }
  if (error instanceof HonuaTimeoutError) {
    notifyUser("Server slow — try again in a moment.");
    return;
  }
  throw error;
}
```

## Retry policy

The SDK's built-in retry (`HonuaClientOptions.retry`) automatically handles a
subset of these errors when configured:

| Error | Retried by built-in `retry`? |
|-------|-------------------------------|
| `HonuaHttpError` with status in `retryStatuses` (default `[408, 429, 500, 502, 503, 504]`) | Yes |
| `HonuaNetworkError` | Yes |
| `HonuaTimeoutError` | Yes |
| `HonuaGrpcError` with retryable code | Yes |
| `HonuaAbortError` | **No** — caller asked to stop |
| `HonuaCapabilityNotSupportedError` | **No** — would never succeed |
| `HonuaWfsExceptionError` | **No** — caller bug |
| `HonuaExplorationContextError` | **No** — state bug |

## Capability policy

`createDataset({ capabilityPolicy: "strict" })` is the default and is recommended
for production. It surfaces capability misses as `HonuaCapabilityNotSupportedError`
*before* the network call, so unsupported features can never silently degrade to
an empty result. `capabilityPolicy: "degraded"` is intended for exploratory tools
that prefer best-effort results with an explicit `degraded` reason annotated on
the `Result`.
