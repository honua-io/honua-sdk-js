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
- **Runtime peers (not bundled):** `maplibre-gl` ^5 || ^6 (dual-major; see `docs/maplibre-runtime.md`), `cesium` ^1.139, `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-web`. Sole runtime dependency: `@maplibre/maplibre-gl-style-spec`.

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
- **Contract conformance:** `npm run test:conformance` (`vitest.conformance.config.ts`) — round-trips the shared, versioned geospatial-grpc fixtures through the real `HonuaClient` against a pinned `honua-server:nightly` and fails on `Dataset`/`Source`/`Query`/`Result` drift. Double-gated on `HONUA_INTEGRATION_BASE_URL` + `HONUA_CONFORMANCE_FIXTURES_DIR`; explicit no-op otherwise. Pull fixtures with `conformance/fetch-fixtures.sh --version <X.Y.Z>`. See `conformance/README.md`.
- **Network-gated sample evidence / cloud-demo tests:** `HONUA_FIRST_MAP_LIVE_ENABLED=true npm run evidence:first-map:live`, `npm run test:cloud-demo:staging`
- **Browser smoke (all):** `npm run test:playwright` (builds first, installs kepler deps, runs Playwright)
- **Split-package build/verify:** `npm run build:split-packages` / `npm run verify:split-packages`
- **Generated MCP client pin:** `npm run verify:mcp-pin` proves the `@honua/mcp-server` version written into generated `.mcp.json` / `claude_desktop_config.json` files belongs to this repo's release lineage, never runs ahead of `mcp/package.json`, and declares a `@honua/sdk-js` peer range that npm's default resolver accepts for the SDK version beside it; `HONUA_MCP_PIN_LIVE_ENABLED=true npm run verify:mcp-pin:live` additionally resolves it against the public npm registry and compares the recorded tarball integrity (network lane; never in PR CI). `test/verify-mcp-pin.test.ts` covers both offline.
- **Pinned client pair co-install:** `npm run verify:client-pair` packs this tree and really installs it beside the pinned `@honua/mcp-server` in a throwaway consumer under **default** peer resolution -- no `--legacy-peer-deps`, no `--force` -- so a cut whose pair only installs with a workaround fails before publish. `npm run verify:client-pair:registry` asks the same question of the two published artifacts (scheduled `mcp-pin-live.yml`). A caret peer range over a prerelease admits exactly one `major.minor.patch` tuple, so the pair has to be cut and pinned on one tuple; widening the range cannot help (#1529).
- **Advancing the generated-config MCP pin:** the pin in `src/local-install.ts` must name a version the registry serves *and* sit on this SDK's own tuple, which only a real coordinated publish satisfies -- so it is deliberately not a release-please `extra-files` bump (release-please would advance it before either half is published, and cannot compute the recorded tarball integrity). After the coordinated `@honua/mcp-server` publish, run `npm run sync:mcp-pin` to advance the version and its integrity together. The pin has two homes -- `src/local-install.ts` and the shipped `mcp/release/zero-to-map/configs/*.json`, which `verify:mcp-pin` requires to name the identical pin -- and the sync moves both in one run, so advancing one alone can never leave the tree failing its own gate. `npm run sync:mcp-pin -- --check` reports drift at every one of those sites without writing. Between a release bump and that publish the pin legitimately lags: PR CI stays green and `verify:client-pair` is what refuses to ship it.
- **Scaffold + playgrounds (`packages/create-honua-app`):** `npm run create-app:verify`, `npm run create-app:test`, `npm run create-app:templates:typecheck`, `npm run create-app:verify:package` (packs the scaffold and scaffolds from the tarball), `npm run playgrounds:check` (regenerate the page with `npm run playgrounds:generate`); the registry lane is `HONUA_CREATE_APP_LIVE_ENABLED=true npm run create-app:time-to-map`. See `docs/create-honua-app.md`.
- **Gallery sample playgrounds (`playgrounds/`):** generated standalone projects for the samples that qualify — `npm run samples:playgrounds:generate` writes them plus the catalog overlay's `playground` links (follow with `npm run samples:migrate:v1`) and the managed `sample-playground` block in each qualifying sample's own `examples/<id>/README.md`, `npm run samples:playgrounds:check` fails on drift in any of the three, `npm run samples:playgrounds:typecheck` compiles them against SDK source, `npm run samples:playgrounds:test` covers the eligibility rules. The scheduled registry lane is `HONUA_PLAYGROUND_LIVE_ENABLED=true npm run samples:playgrounds:smoke` (weekly `sample-playground-live.yml`; never in PR CI): it installs a generated playground from the real npm registry, builds it, serves the production build, and drives it headless. A sample whose data comes from a repository fixture server gets that origin generated too — declare it in `PLAYGROUND_FIXTURE_ORIGINS` (`scripts/sample-playgrounds.mjs`) and the project ships byte-identical copies of the reviewed fixture pack plus a Vite plugin serving the sample's audited same-origin routes. Never edit `playgrounds/` by hand: change the sample under `examples/` and regenerate. See `docs/playgrounds.md`.
- **API docs:** `npm run docs:api` (TypeDoc → `dist/docs-api`)
- **Migration CLI:** `npm run scan:arcgis`, `npm run migrate:arcgis` (wrap `dist/src/migration/cli.js`)
- **Canonical capability keys / coverage snapshot:** `npm run samples:verify` validates `samples/catalog.v2.json`'s `capabilityKeys` against `config/capability-crosswalk.v1.json`; `npm run sdk-coverage:generate` / `npm run sdk-coverage:check` produce and drift-gate `config/sdk-coverage.v1.json` from `config/support-manifest.v1.json` + `config/sdk-coverage-crosswalk.v1.json`. See `docs/capability-keys.md`.
- **Sample-contract look-ahead clock lane:** `npm run samples:contract:lookahead` re-runs `test/sample-contract.test.ts` against a forward-shifted validation clock (+35d and +95d, clearing the 31-day executed and 90-day non-executed evidence windows) so a fixture whose validity silently depends on the wall-clock date fails weeks before it wedges trunk; on failure it bisects the offset and names the date the fixture tips. `HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS` shifts that one suite's clock and nothing else. See the header of `test/sample-contract.test.ts`.
- **Run a demo (dev server):** `npm run demo:<name>` (e.g. `demo:quickstart`, `demo:incident`); each demo also has `:build`, `:preview`, `:typecheck`, and often `:mock`.
- **Proto codegen:** `npm run proto:generate` (requires the sibling `../../proto` tree and `buf`).

MCP package (`cd mcp` or `--prefix mcp`): `npm run build`, `npm run typecheck`, `npm run check`, `npm test`.

CI (`.github/workflows/ci.yml`) runs, in order: `typecheck`, `check`, `build`, `verify:split-packages`, `demo:examples:typecheck`, `demo:primitive-matrix`, kepler `npm audit`, `demo:examples:build`, `test:coverage`, the migration e2e test, then Playwright smoke. The MCP job builds the SDK first, then audits/typechecks/checks/builds/tests `mcp/`.

## Architecture

- Protocol-neutral core contract: `src/contract/` (`Dataset`/`Source`/`Query`/`Result`).
- Client entry points are exposed as subpath exports in `package.json` (`.`, `./honua`, `./contract`, `./esri-compat`, `./migration`, `./expr`, `./webmap`, `./geocoding`, `./geometry`, `./react`, `./map`, `./runtime`, `./realtime`, `./scene-workspace`, `./collaboration`, etc.). Public surface roots: `src/index.ts`, `src/honua.ts`.
- Major source areas (`src/`): `core`, `contract`, `expr` (query expressions), `webmap`, `map` + `runtime` (MapLibre runtime / `MapPackage` loading), `scene-workspace`, `style`, `geocoding`, `realtime` (subscriptions), `esri-compat` + `esri-compat-entry.ts` (ArcGIS drop-in compat), `migration` + `migration-entry.ts` (codemod + CLI), `agent-tools`, `app` / `app-controller` / `app-workspace` / `generated-app`, `collaboration`, `control-plane`, `exploration`, `interactions`, `filter-registry`, `operator`, `studio`, `web-components`. `src/gen` holds buf-generated protobuf code.
- The package publishes as five split packages (see `scripts/prepare-split-packages.mjs`, `docs/split-packages.md`): `honua-sdk`, `honua-sdk-esri-compat`, `honua-migrate`, `honua-react` (`@honua/react`), `honua-geometry` (`@honua/geometry`).
- `mcp/` is an independent MCP server (`@honua/mcp-server`, bin `honua-mcp`) built on `@modelcontextprotocol/sdk` + `zod`; it peer-depends on `@honua/sdk-js`.

## Directory Layout

```
src/            # SDK source (~240 .ts files); see Architecture for subdirs; src/gen is generated
test/           # ~190 vitest specs + test/playwright/*.spec.mjs + test/fixtures (excluded from tsc/biome)
examples/       # ~22 Vite demo apps, each with vite.config.ts, tsconfig.json, often mock-server.mjs
mcp/            # standalone @honua/mcp-server package (own package.json, tsconfig, vitest, biome)
packages/       # standalone packages published from source, not from dist/ (create-honua-app scaffold + its starter templates)
playgrounds/    # GENERATED standalone projects per qualifying gallery sample (scripts/sample-playgrounds.mjs); never hand-edited
scripts/        # *.mjs build/verify/demo helpers
docs/           # design docs, decisions/, features/, examples/
vitest.*.config.ts  # unit (vitest.config.ts), integration, staging, cloud-demo configs
playwright.config.mjs
biome.json tsconfig.json .nvmrc release-please-config.json
```

## Conventions & Gotchas

- ESM + NodeNext: use explicit extensions / `verbatimModuleSyntax`-compatible imports; `import type` is required for type-only imports.
- `npm run check` (Biome) is the style gate in CI — run it (or `check:fix`) before considering work done. Biome rules: `noExplicitAny` is `warn` in `src/` but `off` in `test/`; `useNodejsImportProtocol` and `noNonNullAssertion` are off.
- Dead code is an error, in both the root package and `mcp/`: Biome's `correctness/noUnusedImports`, `noUnusedVariables`, and `noUnusedFunctionParameters` fail `npm run check`, and `noUnusedLocals` fails `npm run typecheck`/`npm run build`. Fix the finding rather than suppressing it; when a binding is deliberately unused (a signature-conforming callback, an intentionally unused parameter) prefix it with `_`, and reserve `// biome-ignore lint/correctness/…: <reason>` for cases where the declaration is load-bearing (for example the published generic arity of a public type). `noUnusedParameters` is deliberately not enabled in `tsconfig.json` — it flags phantom type parameters that must stay for API compatibility and offers no per-site escape hatch.
- `tsc` uses `noEmitOnError`; the build fails on any type error. `test/fixtures` is excluded from tsc and Biome — don't expect it to typecheck. Biome's `files.include` covers `src/**/*.ts` and `test/**/*.ts` but not `.tsx`; `noUnusedLocals` is what gates unused imports in the React sources.
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

## Pull Requests

### Issue disposition footer (CI-enforced)

Every PR body must end with a contiguous block of disposition lines. The
required `PR Issue Disposition` check runs `scripts/check-pr-issue-disposition.mjs`
and **fails the PR** on any deviation, so get it right when you open the PR
rather than after a red check.

Each line is exactly one of:

```
Closes #N
Refs #N (explanation)
```

**Use `Closes` when every acceptance criterion on the issue is met.** Do not
downgrade finished work to `Refs` out of caution — a closed issue is the point
of the work, and leaving a satisfied issue open is its own kind of drift.

**Use `Refs` only when the issue genuinely still has open acceptance
criteria** after this PR merges, and say in the parenthetical what remains.
Typical honest reasons: the rest needs a live candidate server, published
registry bytes, a real release cut, a change in another repository, or a
blocking issue. If you are using `Refs`, you should be able to name the
specific unmet criterion.

The explanation is not free-form. It must:

- be 1–160 characters, trimmed, with no parentheses or newlines inside it;
- contain at least one progress marker — `S<number>`, `slice`, `partial`,
  `remain` / `remains` / `remaining`, `follow-up`, `blocked`, or `handoff`.

Further rules the validator enforces:

- The block may declare several issues (at most 20), one per line, with no
  issue repeated.
- No `Refs #N` may appear anywhere above the block — a stray one in the prose
  fails as `misplaced-reference`.
- No closing keyword tied to an issue (`close`/`closes`/`closed`,
  `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved` followed by `#N`) may
  appear above the block. Write neutral prose and keep closure intent only in
  the footer. "This does not close #123" fails; say "this PR is not sufficient
  on its own" instead.

Valid examples:

```
Closes #1421
```

```
Refs #1397 (server-discovered routing; family/view metadata remains, blocked on honua-server#3428)
Refs #1398 (proposal status client; draft enumeration remains, blocked on honua-server#3003)
```

Syntax-check a body before pushing instead of guessing at the grammar:

```bash
node --input-type=module -e '
import { parsePullRequestDisposition } from "./scripts/lib/pr-issue-disposition.mjs";
import { readFileSync } from "node:fs";
console.log(parsePullRequestDisposition(readFileSync("/tmp/body.md", "utf8")));'
```

This covers the footer grammar only. The required check calls
`validatePullRequestDisposition`, which additionally resolves each declared
issue against the GitHub API — so a footer that is syntactically perfect still
fails the gate when it names an issue that does not exist, is already closed,
lives in another repository, or is actually a pull request, or when GitHub does
not recognise a declared `Closes` reference. A clean parse means the grammar is
right, not that the PR will pass.

### Keeping a PR mergeable

- Trunk protection requires conversation resolution: every review thread must
  be resolved before merge. Judge automated review findings on the evidence —
  fix the real ones, and reject a false positive with concrete proof rather
  than making a no-op change to silence it.
- CI runs **trunk's** workflow against your branch. When a merged PR adds a new
  gate, older branches fail with `Missing script: "<name>"` until they merge
  trunk. Merge or rebase onto `origin/trunk` before diagnosing such a failure
  as a defect in your own work.
- `docs/bundle-sizes.md` is regenerated on trunk by automation and conflicts
  often. Never hand-merge it: take trunk's copy and regenerate.

  ```bash
  git checkout origin/trunk -- docs/bundle-sizes.md
  npm run report:bundle-sizes
  npm run verify:bundle-budgets
  ```

- A ceiling that appears in more than one file must be changed in all of them.
  The `/web-components` gzip ceiling, for example, lives in
  `bundle-budgets.json`, `config/app-platform-reference-evidence.v1.json`, and
  the generated `config/app-platform-reference-qualification.v1.json`
  (regenerate with `npm run qualification:app-platform`).

## Specifica Requirement Format

Product backlog issues, epics, and cross-repo workstreams use the Specifica
format: requirement-first and traceable, not a loose idea note. Every
workstream must be in Specifica.

- If the owning repo has a canonical Specifica source tree or projection
  workflow, follow it rather than hand-editing GitHub as the source of truth
  (`honua-agentflow` projects `.specifica/<slug>/` into its issue via
  `scripts/sync_specifica_issue.py`; there the issue body is a projection —
  update the markdown and sync).
- Otherwise create the issue directly from the canonical templates in
  `honua-io/agent-delivery-spec`: `templates/specifica-epic-issue.md` and
  `templates/specifica-feature-issue.md`. Never file workstreams, demo
  backlogs, platform contracts, or epics as free-form notes.
- Split a broad roadmap item into child Specifica feature issues before work
  starts; for app backlogs prefer one epic carrying the workstream context
  plus one child issue per sample application.
- The incident operations dashboard is realtime by default; never describe it
  as a static dashboard unless the user explicitly changes that requirement.

## Shared dev-environment rules (multi-agent WSL)

This machine runs many agents concurrently (**Codex + Claude**, often via agentflow with multiple tabs/agents). To prevent host lockups and lost work, every agent MUST follow these:

1. **Heavy builds/tests are throttled by a shared lock.** `dotnet` and `npm` are PATH-shimmed, so their build/test/publish/pack and ci/install/test/run-build/run-test subcommands automatically run under a global semaphore (default 1 concurrent, `HONUA_BUILD_SLOTS`). For other heavy tools, call the wrapper explicitly: `with-build-lock pytest ...`, `with-build-lock cargo build`, `with-build-lock make build`. The lock is shared across ALL of this user's processes (every Codex/Claude tab, agentflow children). Do not bypass it for compiles or test suites. Long-running servers (`dotnet run`, `npm run dev`) are intentionally NOT locked — never wrap those.

2. **Commit and push when you finish a task** so your worktree can be reclaimed. An hourly job (`honua-clean`) removes a worktree ONLY when it is clean AND fully pushed (merged, remote-gone, or idle >=2d). Dirty or unpushed worktrees are NEVER touched — but uncommitted/unpushed work blocks reclamation and is at risk if the instance is reset. Build artifacts (bin/obj and untracked node_modules) are reclaimed automatically and safely.

3. **Commit hygiene — no agent attribution.** Author every commit as the repo owner only (git identity: Mike McDougall <mike@honua.io>). Do **NOT** add any agent/tool attribution to commits: no `Co-Authored-By: Claude ...`, no `Co-Authored-By: Codex ...` (or other bot co-authors), and no "Generated with Claude Code" / "Generated with Codex" / "🤖" lines in the message or PR body. Write a plain, descriptive commit message and stop.

4. **Agents outside this WSL environment (Windows Codex/Claude, other machines).** The build lock and worktree conventions above exist only inside WSL. If you are not running inside it: work from your own checkout and never edit the WSL working trees (e.g. via `\\wsl.localhost`) — git remotes are the only shared surface; claim an issue before starting (assign yourself or leave a claiming comment), because agents that cannot see each other's worktrees cannot avoid collisions any other way; and run at most one heavy build/test at a time, avoiding overlap with active WSL builds — no semaphore protects the host across environments.
