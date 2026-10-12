# Ask this map (experimental)

Review a schema-grounded spatial query and execute it against six versioned
incident fixtures. The map and accessible table use the same returned IDs;
counts are never inferred from a SQL substring. Recorded mode accepts only the
labelled exact suggestions and needs no API key. It does not understand arbitrary
text. Live mode requires a separately authenticated server-side model adapter.

```bash
npm run demo:nl-map-control
npm run demo:nl-map-control:build
npm run demo:nl-map-control:typecheck
```

Choose “Show open incidents in this view”, review, and execute. Then group by
type, select incident 1 in the table with the keyboard or on the map, and ask for
those within 500 metres. The first query returns IDs 1, 2, 4 and 5 in the initial
view; the distance refinement returns 1, 2 and 5. After execution, the sample
is explicitly in refinement mode: the host requires every prior filter conjunct
and any grouped count to survive subsequent queries. Choose **Start new question**
to clear that context without clearing displayed results or the selected location.
Moving the map also starts a new question. The (300, 400) offset is exactly
500 metres away and is included; (501, 0) is excluded.

**Distance means planar EPSG:3857 projected metres**, explicitly disclosed in the
preview. It is not geodesic or ground distance. The existing DuckDB semantic
compiler refuses geodesic mode; the sample does not approximate it with a
buffer. Polygon intersection is supported by the same actual spatial engine and
covered in the versioned evaluation corpus. Dates are unavailable because the
fixture schema has no temporal field.

Each proposal captures source/schema/version, authorization identity, viewport,
selected location, mode, and previous accepted query. Map movement, changed
selection, mode, or prompt invalidates review. Refresh is explicit: propose again.
Refinements preserve the previous accepted filter. Rejection, cancellation,
unsupported queries and failures preserve existing map/table results. Execution
consumes a review once and ignores older asynchronous results.

The reusable `createAskMapSession` and `mountAskMapControl` exports live under
`@honua/sdk-js/nl-map-control`. They reuse `createNlMapControl` plans, bounded
self-correction, signed approvals for effectful tools, and execution receipts.
This sample admits only one read-only `runWidgetQuery` step. It never signs a
production approval with a browser-held secret. Hosts adding effectful tools must
provide their existing approval issuer/verifier and source authorization context.

The planner parses structured semantic queries against `SourceSchemaV2` and
compiles them using `compileSemanticDuckDbQuery`. DuckDB-WASM executes the actual
SQL with prepared-statement parameters against a Parquet fixture whose WKB BLOB
column and EPSG:3857 CRS are explicitly declared by the fixture manifest. The
physical field types are checked before admission; no auto-promoted GEOMETRY
column is fed to a WKB decoder. Expandable details show the dialect,
opaque resource, SQL template, ordered binds and execution receipt. Grouped
queries also execute the disclosed feature query with the identical predicate
for map/table synchronization. Raw model SQL and approximate compiler outputs
are rejected before execution. A request is bounded to 100 rows, one plan step,
three model attempts, and 15 seconds total per proposal/execution. The server
adapter has a 12-second provider bound and 64 KiB input/output bounds.

The engine/worker come from the npm lockfile. `engine-assets.mjs` reuses the
existing digest-checked extension cache to self-host pinned Parquet and spatial
extensions. The spatial extension is DuckDB v1.4.3 / wasm_eh, 23,469,719 bytes,
SHA-256 `04b776946da64a15a7b14501790c75093e38f876acc46b2922f0daeb6aaa1d60`.
The first build downloads missing artifacts; subsequent builds validate cached
bytes. Recorded-mode browser execution uses only same-bundle assets. These
optional sample assets do not enter the SDK control bundle.

## Authenticated live mode

`live-adapter.mjs` exposes a small Node HTTP adapter on 127.0.0.1:9879; Vite proxies
`/api/ask-map` to it. Configure these **server-only** environment variables:

- `HONUA_NL_MODEL_ENDPOINT`: fixed HTTPS chat-completions-compatible endpoint.
- `HONUA_NL_MODEL_ID`: reviewed provider model identity.
- `HONUA_NL_MODEL_API_KEY`: provider credential, never a `VITE_` variable.
- `HONUA_NL_APP_ORIGIN`: exact application origin, including development port.
- `HONUA_NL_SESSION_TOKEN`: application session token, at least 32 characters.

```bash
node examples/nl-map-control/live-adapter.mjs
```

Integrate the host's sign-in service to issue the `honua_nl_session` cookie
(HttpOnly, SameSite=Strict, Secure in HTTPS deployments). It must match the
server's application session token. For an existing application, import
`createLiveModelHandler` and inject its real session authenticator and the
provider-neutral completion callback instead. The adapter refuses an absent
session or mismatched Origin before calling the provider, refuses redirects,
and returns sanitized failures. It never returns the model key. No raw prompt or
result history is persisted. Do not expose the local fixture session setup as a
multi-user production authentication system.

The browser offers free-text entry only in live mode. Both modes enter exactly
the same plan validation, semantic compilation, prepared SQL execution and
review/result controls. An HTTP adapter test with a stub provider is **not** live
model evidence.

## Evaluation and current evidence

`evaluation.v1.json` commits independent expected IDs/counts for changed viewport,
attribute filtering, exact distance boundaries, polygon intersection, grouping,
ambiguity and unsupported requests. `src/evaluation.ts` runs the recorded cases
through real plans and the actual spatial engine. The Playwright test attaches
its report separately from UI checks. It never computes expected IDs through the
implementation under test.

The engineering-reviewed acceptance gate (2026-10-12) requires all six supported
cases and all four clarification/refusal controls to pass, with zero unsafe
executions or credential leaks and no case exceeding 15 seconds. The elapsed-time
gate is independent of cooperative cancellation. This ten-case fixture gate is
bounded sample acceptance, not statistically useful general natural-language
accuracy qualification. Preserve failed runs and distinguish each provider/model.

Actual authenticated provider qualification is still in progress; no live pass
is claimed by the recorded results. Keep provider/model, fixture/schema, source
commit, harness identity, latency, outcomes and failures in a separate sanitized
receipt. An externally injected provider bridge must retain its source and hash
alongside that receipt. Experimental API promotion stays with #1459.

After committing the candidate and starting the app/adapter, opt in to the live
corpus runner with the same server configuration plus `HONUA_NL_LIVE_EVIDENCE=true`
and a private `HONUA_NL_EVIDENCE_PATH`. It refuses a dirty tracked tree, uses the
application session only for the browser cookie, and writes a sanitized receipt:

```bash
node examples/nl-map-control/evaluate-live.mjs
```

The runner requires the development server's source-module route. It records
live calls separately, including failed outcomes; it cannot manufacture a live
pass by substituting the recorded model. Each response must report the server adapter's provider/model identity matching
the reviewed evaluation configuration before any query is executed. The
source/harness hashes still need to be joined to the deployed adapter's reviewed
source before admitting the receipt.
