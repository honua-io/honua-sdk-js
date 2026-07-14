# Shared sample kit

The sample kit gives maintained examples one execution contract instead of a
different set of assumptions in every Vite app. Its manifest binds each pilot
to the exact Vite and TypeScript configs, Playwright test, responsive
viewports, required workflow selectors, and SDK entrypoints that qualification
evidence must exercise.

The first pilots are `standalone-quickstart` and `service-explorer`.

## Run the pilots

From the repository root:

```bash
# Inspect the two kit-managed samples without executing them.
npm run samples:list -- --kit

# Run typecheck, build, browser, accessibility, console, responsive, and
# deterministic fixture validation against SDK source.
npm run samples:run -- verify --kit --sdk-mode source

# Pack the SDK, extract it into an isolated bounded tree, and run the same
# pilots only against published package declarations and entrypoints.
npm run samples:run -- verify --kit --sdk-mode packed
```

Select one pilot for a shorter loop:

```bash
npm run samples:run -- typecheck --sample standalone-quickstart
npm run samples:run -- build --sample service-explorer --sdk-mode packed
npm run samples:run -- test --sample standalone-quickstart
npm run samples:run -- dev --sample service-explorer
```

`--dry-run` emits the bounded command plan without starting a child process.
`--json` makes `list` machine-readable. The runner accepts only cataloged
samples, known actions, and reviewed command shapes; it never passes commands
through a shell.

## Evidence receipts

Evidence generation requires a clean source checkout outside the canonical
`samples/evidence/` tree. The runner rejects hidden index inputs, computes an
evidence-neutral source digest, and binds it to both the index and a named
source commit. That commit must exist, have the same evidence-neutral tree, and
remain an ancestor of checkout `HEAD`, so a later evidence-only commit can
validate the receipt without weakening its source binding. Existing evidence
is content-bound before each command group starts, and every group receives a
fresh canonical run root with only that run and the group's receipt paths
mutable:

```bash
npm run samples:run -- evidence --sample standalone-quickstart
npm run samples:run -- evidence --sample service-explorer --gate fixture
```

Receipts and their bound run artifacts are written beneath
`samples/evidence/<sample>/`. Each receipt records its exact
`samples/evidence/<sample>/runs/<lowercase-uuid-v4>` root, and all generated
artifacts must be regular, non-symlink descendants of that root. Re-running one
gate replaces only the receipts co-produced by its command group. The runner
validates every receipt in that group before staging a complete receipt tree
and publishing it with a directory swap; a failed later gate or rename restores
the prior tree without leaving mixed executions. Qualification reconstructs the
same command groups and requires their receipts to share one run root. Cleanup
preserves every run referenced by any current receipt and prunes only
unreferenced UUID run directories, including failed or obsolete attempts.

Live producers are never run implicitly; a profile that requires live evidence
also requires `--allow-live`. The runner supplies an explicit per-run output
path, enable flag, sample ID, and source revision. A producer must create that
fresh output; catalog evidence is not reused. Before issuing a receipt, the
runner scans the evidence and its declared artifacts for the exact credential
values forwarded to the producer.

Packed evidence copies both the package tarball and the sample's final built
`dist` tree into the bound run, then records published-entrypoint resolution
and a content inventory from that self-contained copy. Browser evidence runs
every Playwright project declared by the pilot and binds each result to its
actual browser engine. Console evidence is finalized only after quality checks,
fixture teardown, and explicit closure of the pilot-owned page and browser
context. Screenshot and performance gates execute that same
reviewed browser workflow; the pilot's canonical `evidenceProject` writes a
fully decoded PNG and browser observations with positive, monotonic navigation,
resource, keyboard-interaction, and sample-ready timing.

## Kit contracts

- `vite.config.ts` resolves every declared `@honua/sdk-js` entrypoint from
  either source or an isolated packed SDK and rejects undeclared SDK imports.
- `tsconfig.source.json` is the common strict source-mode baseline. Packed
  typechecks use a generated config whose SDK paths are constrained to the
  extracted package declarations.
- `cleanup.ts` provides idempotent LIFO disposal, including resources
  registered while cleanup is already draining.
- `presentation.ts` and `presentation.css` provide consistent SDK-mode,
  evidence, degradation, error, and disposal UI with an accessible announcer.
- `manifest.v1.json` is the fail-closed binding consumed by the runner and gate
  receipt verifier. Update it whenever a pilot's test identity, required
  workflow, viewport, browser engine matrix, canonical evidence project, or SDK
  imports change.
