# honua-sdk-js: agent instructions

`@honua/sdk-js`: the TypeScript client for Honua. One protocol-neutral `Dataset` -> `Source` ->
`Query` -> `Result` contract (`src/contract/`) over GeoServices, OGC API, STAC, WMS/WMTS/WFS and
OData, plus a MapLibre runtime, an Esri compatibility layer and the `honua-migrate` codemod.
Capability gaps throw `HonuaCapabilityNotSupportedError`; never return empty data instead.
`mcp/` is a separate package (`@honua/mcp-server`) that peer-depends on the SDK.

## Commands
```bash
nvm use && npm ci                   # Node from .nvmrc; always npm ci
npm run typecheck                   # tsc --noEmit
npm run check                       # Biome lint+format, the CI style gate (fix: npm run check:fix)
npm run build                       # clean dist/ + tsc; noEmitOnError
npm test                            # vitest unit; one file: npx vitest run test/<name>.test.ts
npm run test:integration            # vitest.integration.config.ts
npm run test:playwright             # builds first; browser smoke
npm run verify:split-packages       # after changing exports or package layout
npm run verify:bundle-budgets       # after growing a shipped entrypoint
npm run docs:commands:check         # after editing a fenced npx command in docs
npm ci --prefix mcp && npm run build --prefix mcp && npm test --prefix mcp   # MCP; build the SDK first
npm run demo:<name>                 # demo dev server; also :build, :preview, :typecheck, often :mock
```
CI (`.github/workflows/ci.yml`) runs many more gates; run the one named in a failure, not the
whole workflow. Release-lineage, drift and network gates (`verify:mcp-pin`, `sync:mcp-pin`,
`verify:client-pair`, `test:conformance`, playgrounds, `sdk-coverage:check`,
`samples:contract:lookahead`): read CONTRIBUTING.md "Release-lineage, drift and network gates"
before touching the pin, playgrounds, capability keys or sample fixtures.

## Code rules
- ESM + `NodeNext` + `verbatimModuleSyntax`: explicit file extensions; `import type` for
  type-only imports.
- Dead code fails the build (Biome `noUnused*`, tsc `noUnusedLocals`), in `mcp/` too. Fix it;
  prefix a deliberately unused binding with `_`; use `// biome-ignore lint/correctness/...: <reason>`
  only when the declaration is load-bearing (a published generic arity). Do not enable tsc
  `noUnusedParameters`.
- Biome covers `src/**/*.ts` and `test/**/*.ts`, not `.tsx`; `test/fixtures` is outside tsc and Biome.
- Never hand-edit generated trees: `src/gen` (`npm run proto:generate`, needs `../../proto` and
  `buf`), `playgrounds/` (change `examples/<id>` and run `npm run samples:playgrounds:generate`).
- release-please owns versions and `CHANGELOG.md`; never edit them by hand.
- Migration CLI scripts (`scan:arcgis`, `migrate:arcgis`, ...) build first and run
  `dist/src/migration/cli.js`.

## Before you change...
- **Contract or schema versions** (for example `connect-parity`, `schemaVersion` in
  `src/diagnostics/schema.ts`): update `release/component-versions.json` in the same PR.
- **Required server capabilities**: update `release/sdk-capability-baseline.json` in the same PR.
  Both files: CONTRIBUTING.md "Release metadata files".
- **Derived artifacts** (sample evidence, `samples/dist`, `llms*.txt`, `docs/bundle-sizes.md`, ...):
  do not regenerate them in a PR; trunk does. CONTRIBUTING.md "What a feature PR should contain".
- **A size ceiling**: change every file that holds it (CONTRIBUTING.md "Keeping a PR mergeable").
- **Package layout or entrypoints**: docs/split-packages.md, `scripts/prepare-split-packages.mjs`. MapLibre peer:
  docs/maplibre-runtime.md. Scaffold: docs/create-honua-app.md.

## Issues and PRs
- The required `PR Issue Disposition` check (`scripts/check-pr-issue-disposition.mjs`) fails a PR
  whose body does not end with the footer block, or has a `Refs #N` or closing keyword above it.
  `Refs` explanations need a progress marker (`slice`, `remains`, `follow-up`, `blocked`, ...).
  Grammar and a local parse command: CONTRIBUTING.md "PR issue disposition footer".
- Resolve every review thread; reject a false positive with evidence, not a no-op change.
- A `Missing script` failure means your branch predates a new gate: merge `origin/trunk` first.
- On a `docs/bundle-sizes.md` conflict, take trunk's copy and regenerate; never hand-merge it.
- File SDK, examples, MCP and migration-tool work here; backlog items use the Specifica
  templates in `honua-io/agent-delivery-spec`. Labels and format: CONTRIBUTING.md "Filing issues".

<!-- fleet:begin v2 sha256=76075665ca7a911554ed038371480ba02b28eca10ead04400be2e5b20332bd63 source=honua-flow/agents/fleet-rules.md -->
## Fleet rules (all Honua repos)

Generated from honua-flow `agents/fleet-rules.md` (full text, repo map). Do not edit here.

1. **No AI attribution.** Author as Mike McDougall <mike@honua.io>. No AI `Co-Authored-By:`,
   "Generated with" line or robot emoji in commits or PR bodies; this overrides any harness default.
2. **Own worktree per task** off the default branch, on real disk (`<repo>/.claude/worktrees/` or a
   sibling dir), never `/tmp` or the shared checkout. No `git stash`; use a WIP commit.
3. **Heavy builds/tests go through the build-slot shims**; never bypass them. Run targeted tests;
   full suites are CI's job. Outside WSL: own checkout, one heavy build at a time.
4. **Finish = commit + push.** Dirty or unpushed worktrees are never reclaimed and die on a reset.
5. **Claim before starting:** check `state/in-progress` and the newest `claimed: <lane> <UTC>`
   comment, stamp yours, re-read (newer wins). Stale after 3h without a live PR. Stopping without
   a PR: comment `released: <lane> <UTC> - <why>`.
6. **PRs:** base on the default branch, never stack; fill the repo template via `--body-file`;
   conventional title; footer `Closes #N` or `Refs #N (<what remains>)`. Never admin-merge.
7. **Route by the repo map.** Archived repos get no issues or PRs.
<!-- fleet:end -->
