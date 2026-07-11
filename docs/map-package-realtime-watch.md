# MapPackage Realtime Watch

`watchMapPackage` can follow hosted `MapPackage` changes over a realtime
channel when one is configured by the caller or advertised by the package. The
polling watcher remains the fallback path and is still used when no realtime
channel is available.

## Client Usage

```ts doc-test=skip reason="partial excerpt requires application host context"
import { watchMapPackage } from "@honua/sdk-js/runtime";

const watcher = watchMapPackage("map_123", {
  client,
  runtime,
  realtime: {
    url: "/api/v1/map-packages/map_123/watch",
    withCredentials: true,
    staleAfterMs: 90_000,
  },
  onEvent(event) {
    if (event.type === "fallback") console.warn(event.reason);
    if (event.type === "reload-required") console.info(event.reason);
  },
});

watcher.dispose();
```

When `realtime` is omitted, `watchMapPackage` looks for an advertised channel
on the current or fetched package:

```json
{
  "realtime": {
    "mapPackageWatch": {
      "channel": "honua.map-package.watch.v1",
      "transport": "sse",
      "href": "/api/v1/map-packages/map_123/watch",
      "withCredentials": true,
      "staleAfterMs": 90000,
      "fallback": "polling"
    }
  }
}
```

The SDK currently ships an SSE adapter and accepts custom transports through
`realtime.transport`. Unsupported advertised transports fall back to polling.

## Message Contract

All messages are JSON objects on channel `honua.map-package.watch.v1`. A server
may send the object directly or wrap it as `{ "event": { ... } }`.

Common fields:

```ts doc-test=compile
interface MapPackageRealtimeMessageBase {
  type: string;
  channel?: "honua.map-package.watch.v1";
  packageId?: string;
  eventId?: string;
  sequence?: number;
  fingerprint?: string;
  updatedAt?: string;
  validator?: { etag?: string; lastModified?: string };
}
```

Supported message types:

- `ready`: channel is established. The SDK also emits `connected` when the
  transport opens.
- `heartbeat`: keepalive. Resets SDK stale timers when configured.
- `stale`: server says the subscription is stale. The SDK emits `stale` and,
  by default, falls back to polling.
- `updated`: package changed. The update payload must be one of:
  `{ kind: "package", mapPackage }`, `{ kind: "refetch", path? }`, or
  `{ kind: "patch", patch, baseFingerprint? }`.
- `refetch-required`: explicit refetch signal. Equivalent to an `updated`
  message with `{ kind: "refetch" }`.
- `reload-required`: server knows the change requires a full style reload; the
  SDK emits `reload-required` after diffing the fetched or supplied package.
- `error`: channel error. `terminal: true` falls back to polling immediately.
- `disconnected`: server is closing the channel. The SDK reconnects, then
  falls back if reconnect attempts are exhausted.

Patch payloads are intentionally distinguishable, but the runtime does not yet
apply server patches directly. A patch-only update triggers a refetch through
the polling fetch path so existing validation, cache, and diff behavior stays
consistent.

## Lifecycle And Fallback

`watchMapPackage` emits typed watch events:

- `connected`
- `disconnected`
- `stale`
- `updated`
- `reload-required`
- `fallback`
- `error`
- Existing polling events: `fetched`, `unchanged`, and `disposed`

Realtime reconnect defaults to 3 attempts with exponential backoff from 1s to
30s. Configure it with `realtime.reconnect`, set it to `false` to skip
reconnect and fall back immediately, or use `maxAttempts: Infinity` to keep
retrying.

Duplicate application is avoided with three guards:

- `eventId` values are remembered for recent realtime update messages.
- `sequence` values at or below the last applied realtime update are ignored.
- The package fingerprint is compared before `updated` is emitted or
  `runtime.updatePackage` is called.

`dispose()` aborts active fetches, aborts the realtime subscription signal,
closes the transport handle, clears reconnect/stale/debounce timers, and emits
`disposed`.

## Auth

Polling fetches use `HonuaClient.pipelineFetch`, so they inherit client auth,
headers, retries, timeout, and interceptors.

SSE in browsers cannot send arbitrary headers. For the built-in SSE adapter:

- Use same-origin cookies with `withCredentials` or
  `realtime.auth: { kind: "cookie", withCredentials: true }`.
- Use `realtime.auth: { kind: "query-token", token }` only when the deployment
  explicitly allows token-bearing watch URLs.
- Use `realtime.transport` for WebSocket, fetch-stream, or platform-specific
  transports that need custom auth headers.

When realtime auth fails, servers should send an `error` message with
`terminal: true` and a stable `code`; the SDK emits `error`, then `fallback`.
