# create-honua-app

`create-honua-app` scaffolds a Vite + TypeScript application that already connects to a geospatial endpoint and mounts
a source on MapLibre. It exists so the first minute with the SDK is spent reading a working workflow instead of
assembling peer dependencies.

```bash
npm create honua-app@latest my-map
cd my-map
npm install
npm run dev
```

The starter package lives in this repository at `packages/create-honua-app`.

## Templates

| Template | Entry point | What it demonstrates |
| --- | --- | --- |
| `vanilla-ts` (default) | `src/main.ts` | `connect → inspect → explain → query → mount`. The SDK owns the MapLibre map and mounts an accepted query plan. |
| `react-ts` | `src/App.tsx` | The app owns a plain `maplibre-gl` map; the same kernel connection inspects, explains, queries, and mounts onto it. |

Both templates pin **MapLibre GL JS 6.1.0**, the current major, and `npm run create-app:verify` fails if a template
ever pins a major the SDK does not support. A scaffolded app installs `@honua/sdk-js` **from the registry**, so this
pin could only move once a published release carried the widened `^5.0.0 || ^6.0.0` peer range (#1004);
`@honua/sdk-js@0.1.9-beta.0` is that release, and `npm install` resolves the pair with no `overrides` and no
`--legacy-peer-deps`. MapLibre 5 remains supported by the SDK for apps that have not migrated. Because MapLibre 6 is
ESM-only and loads its worker as a separate module, each starter ships `src/maplibre-worker.ts` and imports it before
the first map is created. See [`maplibre-runtime.md`](./maplibre-runtime.md#maplibre-5-and-6-compatibility).

The starters are SDK-only applications and do not install `@honua/mcp-server`. Their coordinated-pair obligation is
to pin the SDK half to the exact version selected for the published MCP/SDK pair in `src/local-install.ts`.
`verify:mcp-pin` rejects drift at any template or manifest site, and `sync:mcp-pin` advances all of those sites in the
same validated write plan as the generated MCP client pins.

```bash
npm create honua-app@latest my-map -- --template react-ts
create-honua-app --list-templates
```

The copyable core of the vanilla starter is the published workflow, not a private shortcut:

```ts doc-test=skip reason="the scaffolded starter runs this against its own dev-server fixture endpoint"
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

const honua = createHonua();
const connection = await honua.connect(
  { url: endpoint, protocol: "geoservices-feature-service" },
  { authorizationScopeFingerprint: "anonymous-public" },
);
const inspection = await connection.inspect();
const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
const plan = await connection.explain({ returnGeometry: true, pagination: { limit: 250 } }, { sourceId });
const mounted = await connection.mount("#map", { renderer: maplibreRenderer(maplibregl), query: plan, sourceId });
await mounted.ready;
```

## The fixture-first default

Both starters ship a committed GeoServices fixture (the reviewed First Map sample fixture) and serve it from the Vite
dev and preview servers. The default lane therefore needs no account, no API key, and no third-party network call —
which is also what makes the starters runnable in a browser playground. See
[Zero-install playgrounds](./playgrounds.md).

Set `VITE_HONUA_ENDPOINT` (and optionally `VITE_HONUA_PROTOCOL`) to run the identical code against any anonymous,
CORS-enabled GeoServices FeatureServer layer or OGC API Features landing page. Durable credentials never belong in
Vite environment variables: Vite embeds them in public JavaScript.

## Publication

`create-honua-app` is released by release-please as its own component
(`packages/create-honua-app` in `release-please-config.json`, tag `create-honua-app-v<version>`) and published by
`.github/workflows/publish-create-honua-app.yml` through npm trusted publishing — the same OIDC path the SDK and the
MCP server use, with no `NPM_TOKEN`. Before publishing, that workflow runs the scaffold gates and
`npm run create-app:verify:package`, which packs the tarball, installs it into a throwaway consumer, and scaffolds
from the installed copy: a `files` omission or npm's default `.gitignore` exclusion would otherwise ship starters that
cannot find their own templates while every source-tree gate stayed green.

## How the starters stay current

- `packages/create-honua-app/templates.manifest.json` is the single source of truth for the template list, the pinned
  SDK version, and the playground providers. The CLI, the playground page, and the verifier all read it.
- `npm run create-app:verify` fails when a template is missing a file, depends on a version range instead of an exact
  pin, drifts from the reviewed fixture pack, or advertises a playground link that does not address its directory.
- `npm run create-app:templates:typecheck` compiles both templates against the repository's SDK sources, so an API
  change that breaks a starter breaks CI.
- `npm run create-app:test` covers the CLI grammar, the scaffold behaviour, and the evidence contract.
- `npm run playgrounds:check` fails when `docs/playgrounds.md` drifts from the manifest.

## Time-to-first-map evidence

`npm run create-app:time-to-map` measures the whole path — scaffold, `npm install`, `npm run build`, serve, and a
Chromium probe that waits for a MapLibre canvas with rendered features — against a two-minute budget and writes
`test-results/create-honua-app-time-to-map.json`.

The install step reaches the npm registry, so the lane is opt-in:

```bash
HONUA_CREATE_APP_LIVE_ENABLED=true npm run create-app:time-to-map
```

Without the flag the script records a skip document instead of a measurement. A passing document requires a mounted
map, at least one rendered feature, zero console errors, and zero off-origin requests.
