fix(geoservices): re-measure automatic query GET after request interceptors
Follow-up to #1725 (review thread PRRT_kwDORdfQhM6iF-ix, "Include interceptor-added parameters in the GET budget").

## Problem
`queryFeaturesRest` / `queryMapLayer` pick GET vs POST from the 2,000-char request-target budget **before** `executeRequest` runs before-interceptors. A query-mode `createArcGisTokenInterceptor` then appends `token=` to the URL, so a query measured at e.g. 1,990 chars goes out as a >2,000-char GET and can still hit HTTP 431, which is the failure #1725 exists to avoid.

That thread was resolved on #1725 citing commit c0b9e6f, but c0b9e6f was pushed ten minutes after #1725 merged and never reached trunk. It also dropped the guard that stops interceptor-rewritten requests from inheriting read-query replay. This PR re-implements the fix from trunk and keeps that guard.

## Change
- `HonuaJsonRequestPolicy.autoPostAboveTargetLength`: GeoServices sets it on automatic (caller did not pick a method) query GETs, both the JSON path and the PBF fast path.
- `executeRequest` re-measures the target after before-interceptors run. If it is over the budget, it moves the query string into a form-encoded POST body (`f=pbf` → `f=json`, because binary negotiation is GET-only) and uses `preserve-method` redirects so the body cannot be dropped.
- The converted POST keeps transient-retry / auth-refresh replay only when interceptors kept the endpoint path. An interceptor that retargets the request gets a POST with no replay.
- Explicit `method: "GET"` / `"POST"` choices are unchanged.

## Tests
`test/geoservices-large-query.test.ts` adds 8 cases. Each one sizes `where` so the pre-interceptor target is exactly 1,990 chars, then adds a 200-char ArcGIS query token:
- conversion to POST with token, `where`, and `f=json` in the body: `queryFeatures` (JSON and binary) and `queryMapLayer`
- 503 retry still replays the converted POST (all three entry points)
- an interceptor that changes the endpoint gets no replay
- an explicit GET stays a GET

7 of the new cases fail against trunk `src/` and pass with this change.

## Verification
- `npx tsc --noEmit`
- `npx biome check src/core/client.ts src/core/geoservices.ts src/core/protocol-transport.ts test/geoservices-large-query.test.ts`
- `npx vitest run test/geoservices-large-query.test.ts test/geoservices-query-replay.test.ts test/esri-request-compat.test.ts test/request-interceptors.test.ts` (70/70)
- `npx vitest run test/geoservices-*.test.ts test/request-interceptors.test.ts test/retry-jitter.test.ts test/client-*.test.ts`: all pass except a 5 s timeout in `client-grpc-transport.test.ts`, which also flakes on trunk `src/` under host load (1 of 3 trunk runs failed)

## Follow-ups (P3, not in scope)
- Already on trunk: an automatic POST whose URL a query-mode token interceptor rewrites (`?token=`) loses read-query replay, because the guard compares the full URL. Comparing origin + path would restore it.
