# honua-sdk-js: agent instructions

`@honua/sdk-js`: the TypeScript client for Honua. One protocol-neutral `Dataset` -> `Source` ->
`Query` -> `Result` contract (`src/contract/`) over GeoServices, OGC API, STAC, WMS/WMTS/WFS and
OData, plus a MapLibre runtime, a client compatibility layer and the `honua-migrate` codemod.
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
- Vocabulary: exported names, docs and error messages use the Honua vocabulary (honua-server
  `docs/concepts/domain/README.md`, shared policy `scripts/ci/retired-terms.v1.json`).
  `test/vocabulary-public-names.test.ts` fails on a new export carrying a retired term; its
  exceptions file (`test/fixtures/vocabulary/`) only shrinks. Rename outright, as a breaking change
  (`!` commit): no deprecated aliases, re-exports or shims for the old name. Add the old -> new pair to
  the fixture's `renamed` list and to `docs/vocabulary-renames.md`. Leave server wire fields, error codes and format ids unchanged.
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
- For review, publication and CI triage, load org skills `honua-pr-flow` and `honua-ci-map`.
- Unit coverage reruns reuse shard artifacts; inspect the original shard failure. A rerun of the
  coverage merger cannot disprove a shard timing flake. Keep latency ceilings in `bench:lab`.
- For a `Missing script` failure, inspect the failing gate and CONTRIBUTING.md; merge trunk into
  an open PR only for a reported conflict or a failing required check fixed on trunk.
- On a `docs/bundle-sizes.md` conflict, take trunk's copy and regenerate; never hand-merge it.
- File SDK, examples, MCP and migration-tool work here; backlog items use the Specifica
  issue forms. Labels and format: CONTRIBUTING.md "Filing issues"; process: org skill `honua-dev-loop`.

## Review guidelines
Reviews (people, Codex, Claude) judge the lines a PR adds or changes by Robert C. Martin's *Clean Code*
and cite smell codes ([rubric](https://github.com/honua-io/.github/blob/main/clean-code/RUBRIC.md)). The
`Clean code` PR check enforces what a tool can decide; `quality-exception: <reason>` in the PR body is logged.

BLOCKING:
- G5 duplication: search first; reuse or consolidate, never copy a handler, parser or validator.
- C1 history, ticket/PR refs or reviewer notes in code; C2-C4 obsolete, redundant or rambling comments;
  C5 commented-out code. Comment only what the code cannot say.
- XML doc comments (`///`) in application code; published SDKs keep at most a one-line `<summary>`
  on public members.
- N1 names that hide intent; F1 more than 3 parameters; F2 output arguments; F3 boolean flag arguments.
- Over budget with no reason in the PR: functions ~40 lines or 2 nesting levels; classes, files ~400 lines.

WARNING: the rubric's other smells (N2-N7, G6-G36, T1-T9), e.g. G25 magic numbers or G12
single-implementation interfaces.

<!-- fleet:begin v3 sha256=4faeba041ae102508d105847af58b407641cbfdf1ae506488819a2ccdbe73e29 -->
## Fleet rules (all Honua repos)

Generated from the org fleet-rules source; do not edit this block. Start with org skill `honua-system-map`.

1. Author commits as the repository owner's configured git identity. No AI attribution in commits or PR bodies.
2. Use a separate worktree per task, off the default branch, on durable disk. Include current trunk before opening a PR. No shared-checkout edits or git stash; preserve work with commits.
3. Run .NET builds and tests only through the approved remote build-host shims. Never fall back to a local build. See org skill `honua-build-host`.
4. Commit and push completed work; keep existing branches, commits and worktrees until their retention rules permit cleanup.
5. Claim work before starting, reread the issue and current lane rulings, and release the claim after completion. See org skill `honua-dev-loop`.
6. Use a PR slot and bundle at least three issues, a plan row, or a permitted single-work reason. Current caps and exceptions come from current lane rulings.
7. Target the default branch with the repository's PR template and conventional title. Never force-push or use an admin merge.
8. Run pre-PR checks, obtain one independent review of the final head, and resolve every review thread. Merge on green required checks; arm auto-merge where enforced checks support it. See org skill `honua-pr-flow`.
9. Read failed required-check logs and fix in one push. For red trunk, fix forward or revert within the repository's current ruling deadline; see org skills `honua-red-pr` and `honua-trunk-red`.
10. Never commit secrets, deployment identifiers, private repository names or infrastructure details. Security findings belong in the private tracker. Archived repos get no issues or PRs; public instructions name org skills only.
<!-- fleet:end -->
