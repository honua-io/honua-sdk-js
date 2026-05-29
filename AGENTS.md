# Honua SDK JS Agent Instructions

## Overview

`@honua/sdk-js` is the JavaScript / TypeScript client for the Honua geospatial
platform. It exposes a single protocol-neutral `Dataset` → `Source` → `Query` →
`Result` contract over many open geospatial protocols (Esri GeoServices, OGC API
Features / Tiles / Maps / Processes, STAC, WMS, WMTS, WFS 2.0, OData v4), and
ships a MapLibre-first map runtime plus an Esri compatibility layer and codemod
(`honua-migrate`) for migrating existing ArcGIS apps file-by-file. Capability
gaps throw `HonuaCapabilityNotSupportedError` rather than returning empty data.

This repo also contains a separate MCP server package (`@honua/mcp-server`) under
`mcp/` and ~22 runnable example apps under `examples/`.

## Tech Stack

- **Language:** TypeScript (`strict`, `verbatimModuleSyntax`, `module`/`moduleResolution` = `NodeNext`, target `ES2022`), ESM only (`"type": "module"`).
- **Node:** `>=20.0.0` required; CI and `.nvmrc` pin `20.19.0`.
- **Build:** `tsc` (no bundler for the library; `dist/` output).
- **Tests:** Vitest (unit, integration, staging, cloud-demo configs) + Playwright (browser/demo smoke).
- **Lint/format:** Biome 1.9.4 (`biome.json`).
- **Examples/demos:** Vite 7.
- **Protobuf/RPC:** `@bufbuild/*` + `@connectrpc/*` (buf codegen; generated code in `src/gen`).
- **Runtime peers (not bundled):** `maplibre-gl` ^5, `cesium` ^1.139, `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-web`. Sole runtime dependency: `@maplibre/maplibre-gl-style-spec`.

## Setup

```bash
nvm use            # Node 20.19.0 (.nvmrc)
npm ci             # install root deps (use npm ci, lockfile present)
```

For the MCP server, build the SDK first, then install in `mcp/`:

```bash
npm ci && npm run build          # build the SDK that mcp/ depends on
npm ci --prefix mcp
```

## Commands

Run from the repo root unless noted. These are copied from `package.json` / CI; do not invent variants.

- **Build:** `npm run build` (cleans `dist/` then `tsc -p tsconfig.json`)
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`)
- **Lint:** `npm run lint` (Biome lint over `src/`, `test/`, and example dirs)
- **Lint+format check (CI gate):** `npm run check` (Biome `check`); auto-fix: `npm run check:fix`
- **Format:** `npm run format` / `npm run format:fix`
- **Unit tests:** `npm test` (`vitest run`); coverage: `npm run test:coverage`
- **Integration tests:** `npm run test:integration` (`vitest.integration.config.ts`)
- **Staging / cloud-demo tests:** `npm run test:quickstart:staging`, `npm run test:cloud-demo:staging`
- **Browser smoke (all):** `npm run test:playwright` (builds first, installs kepler deps, runs Playwright)
- **Split-package build/verify:** `npm run build:split-packages` / `npm run verify:split-packages`
- **API docs:** `npm run docs:api` (TypeDoc → `dist/docs-api`)
- **Migration CLI:** `npm run scan:arcgis`, `npm run migrate:arcgis` (wrap `dist/src/migration/cli.js`)
- **Run a demo (dev server):** `npm run demo:<name>` (e.g. `demo:quickstart`, `demo:incident`); each demo also has `:build`, `:preview`, `:typecheck`, and often `:mock`.
- **Proto codegen:** `npm run proto:generate` (requires the sibling `../../proto` tree and `buf`).

MCP package (`cd mcp` or `--prefix mcp`): `npm run build`, `npm run typecheck`, `npm run check`, `npm test`.

CI (`.github/workflows/ci.yml`) runs, in order: `typecheck`, `check`, `build`, `verify:split-packages`, `demo:examples:typecheck`, `demo:primitive-matrix`, kepler `npm audit`, `demo:examples:build`, `test:coverage`, the migration e2e test, then Playwright smoke. The MCP job builds the SDK first, then audits/typechecks/checks/builds/tests `mcp/`.

## Architecture

- Protocol-neutral core contract: `src/contract/` (`Dataset`/`Source`/`Query`/`Result`).
- Client entry points are exposed as subpath exports in `package.json` (`.`, `./honua`, `./contract`, `./esri-compat`, `./migration`, `./expr`, `./webmap`, `./geocoding`, `./map`, `./runtime`, `./realtime`, `./scene-workspace`, `./collaboration`, etc.). Public surface roots: `src/index.ts`, `src/honua.ts`.
- Major source areas (`src/`): `core`, `contract`, `expr` (query expressions), `webmap`, `map` + `runtime` (MapLibre runtime / `MapPackage` loading), `scene-workspace`, `style`, `geocoding`, `realtime` (subscriptions), `esri-compat` + `esri-compat-entry.ts` (ArcGIS drop-in compat), `migration` + `migration-entry.ts` (codemod + CLI), `agent-tools`, `app` / `app-controller` / `app-workspace` / `generated-app`, `collaboration`, `control-plane`, `exploration`, `interactions`, `filter-registry`, `operator`, `studio`, `web-components`. `src/gen` holds buf-generated protobuf code.
- The package publishes as three split packages (see `scripts/prepare-split-packages.mjs`, `docs/split-packages.md`): `honua-sdk`, `honua-sdk-esri-compat`, `honua-migrate`.
- `mcp/` is an independent MCP server (`@honua/mcp-server`, bin `honua-mcp`) built on `@modelcontextprotocol/sdk` + `zod`; it peer-depends on `@honua/sdk-js`.

## Directory Layout

```
src/            # SDK source (~240 .ts files); see Architecture for subdirs; src/gen is generated
test/           # ~190 vitest specs + test/playwright/*.spec.mjs + test/fixtures (excluded from tsc/biome)
examples/       # ~22 Vite demo apps, each with vite.config.ts, tsconfig.json, often mock-server.mjs
mcp/            # standalone @honua/mcp-server package (own package.json, tsconfig, vitest, biome)
scripts/        # *.mjs build/verify/demo helpers
docs/           # design docs, decisions/, features/, examples/
vitest.*.config.ts  # unit (vitest.config.ts), integration, staging, cloud-demo configs
playwright.config.mjs
biome.json tsconfig.json .nvmrc release-please-config.json
```

## Conventions & Gotchas

- ESM + NodeNext: use explicit extensions / `verbatimModuleSyntax`-compatible imports; `import type` is required for type-only imports.
- `npm run check` (Biome) is the style gate in CI — run it (or `check:fix`) before considering work done. Biome rules: `noExplicitAny` is `warn` in `src/` but `off` in `test/`; `useNodejsImportProtocol` and `noNonNullAssertion` are off.
- `tsc` uses `noEmitOnError`; the build fails on any type error. `test/fixtures` is excluded from tsc and Biome — don't expect it to typecheck.
- Releases are managed by release-please (`release-please-config.json`, `.release-please-manifest.json`); do not hand-edit version numbers or `CHANGELOG.md`.
- Migration CLI scripts (`scan:arcgis`, `migrate:arcgis`, `report:migration:*`, `gate:migration:*`, `matrix:*`) all build first and invoke `dist/src/migration/cli.js`.
- The MCP package must be built/tested with the SDK already built (it consumes `@honua/sdk-js`); CI builds the SDK before the MCP job.
- `proto:generate` depends on a sibling monorepo path `../../proto` that may not exist in a standalone checkout.

## GitHub Issues

When the user asks for a ticket, backlog item, epic, workstream, or GitHub issue:

- Create the issue with `gh issue create` in the owning repository. Do not leave the work only in chat or a temporary docs file unless the user explicitly asks for a draft.
- Search existing open and closed issues before filing to avoid duplicates.
- For work that primarily demonstrates or exercises the JavaScript SDK, examples, MCP package, or migration tooling, default to `honua-io/honua-sdk-js`.
- For work that spans the Honua platform, create an umbrella issue in the coordinating repo and child issues in implementation repos when the scope is concrete enough. If only one issue is requested, include an `Affected repos` section.
- Use existing labels when practical: `enhancement`, `area/sdk`, `area/mcp`, `area/server`, `area/infrastructure`, `phase/MVP`, `phase/Beta`, `priority/P*`, and `effort/*`.

## Specifica Requirement Format

Use the Specifica format for product backlog issues, epics, and cross-repo workstreams. The issue body should be requirement-first and traceable, not a loose idea note.

Every workstream must be in Specifica. If the owning repo already has a
canonical Specifica source tree or projection workflow, follow that repo's
pattern instead of hand-editing GitHub as the source of truth. For example,
`honua-agentflow` uses `scripts/sync_specifica_issue.py` to project
`spec.md`, `design.md`, and `tasks.md` from a `.specifica/<slug>/` item into a
GitHub issue. In that style, update the canonical markdown and sync the issue;
the issue body is a projection.

When no repo-local Specifica tree exists, create the GitHub issue directly with
the Specifica sections below. Do not file broad workstreams, demo backlogs,
platform contracts, or epics as free-form notes. If a broad roadmap item needs
scheduled implementation, split it into child Specifica feature issues before
work starts.

### Epic / Workstream Issue

```md
## Specifica

Type: Epic
Workstream: <short workstream name>
Owner repo: <repo>
Affected repos: <repo list>
Priority: <P0-P4>
Phase: <MVP/Beta/GA/Future>

## Context

<Why this workstream exists, who it serves, and how it fits the Honua platform.>

## User Outcomes

- <Outcome 1>
- <Outcome 2>

## Scope

- <In-scope capability>
- <In-scope capability>

## Non-Goals

- <Explicitly excluded work>

## Requirements

- REQ-001: <testable requirement>
- REQ-002: <testable requirement>

## Acceptance Criteria

- [ ] <observable acceptance criterion>
- [ ] <observable acceptance criterion>

## Dependencies

- <dependency or "None">

## Validation

- <tests, demos, CI gates, or manual validation required>
```

### Child Feature / App Issue

```md
## Specifica

Type: Feature
Parent epic: <issue link or "TBD">
Workstream: <same workstream as epic>
Owner repo: <repo>
Affected repos: <repo list>
Priority: <P0-P4>
Phase: <MVP/Beta/GA/Future>

## Context

<User problem and product context.>

## User Workflow

1. <User step>
2. <User step>
3. <User step>

## Requirements

- REQ-001: <testable functional requirement>
- REQ-002: <testable functional requirement>
- NFR-001: <performance, reliability, security, caching, or accessibility requirement>

## Acceptance Criteria

- [ ] <observable acceptance criterion>
- [ ] <observable acceptance criterion>

## Data, Caching, and Realtime Notes

- <Metadata cache expectations, live-data constraints, realtime cadence, or explicit no-cache decisions.>

## Validation

- <unit/integration/e2e/manual validation required>
```

For app backlog issues, prefer one epic that carries the workstream context and one child issue per sample application. The incident operations dashboard must be treated as realtime by default; do not describe it as a static dashboard unless the user explicitly changes that requirement.

## Shared dev-environment rules (multi-agent WSL)

This machine runs many agents concurrently (**Codex + Claude**, often via agentflow with multiple tabs/agents). To prevent host lockups and lost work, every agent MUST follow these:

1. **Heavy builds/tests are throttled by a shared lock.** `dotnet` and `npm` are PATH-shimmed, so their build/test/publish/pack and ci/install/test/run-build/run-test subcommands automatically run under a global semaphore (default 1 concurrent, `HONUA_BUILD_SLOTS`). For other heavy tools, call the wrapper explicitly: `with-build-lock pytest ...`, `with-build-lock cargo build`, `with-build-lock make build`. The lock is shared across ALL of this user's processes (every Codex/Claude tab, agentflow children). Do not bypass it for compiles or test suites. Long-running servers (`dotnet run`, `npm run dev`) are intentionally NOT locked — never wrap those.

2. **Commit and push when you finish a task** so your worktree can be reclaimed. An hourly job (`honua-clean`) removes a worktree ONLY when it is clean AND fully pushed (merged, remote-gone, or idle >=2d). Dirty or unpushed worktrees are NEVER touched — but uncommitted/unpushed work blocks reclamation and is at risk if the instance is reset. Build artifacts (bin/obj and untracked node_modules) are reclaimed automatically and safely.

3. **Commit hygiene — no agent attribution.** Author every commit as the repo owner only (git identity: Mike McDougall <mike@honua.io>). Do **NOT** add any agent/tool attribution to commits: no `Co-Authored-By: Claude ...`, no `Co-Authored-By: Codex ...` (or other bot co-authors), and no "Generated with Claude Code" / "Generated with Codex" / "🤖" lines in the message or PR body. Write a plain, descriptive commit message and stop.
