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

Evidence generation requires a clean checkout. The runner content-binds the
repository's tracked `test-results` baselines and permits new output only under
the selected sample's controlled directory. That makes the source revision,
producer bytes, unchanged baselines, and fresh artifacts part of the receipt
boundary:

```bash
npm run samples:run -- evidence --sample standalone-quickstart
npm run samples:run -- evidence --sample service-explorer --gate fixture
```

Receipts are written beneath
`test-results/sample-evidence/<sample>/receipts/`. Live producers are never run
implicitly; a profile that requires live evidence also requires
`--allow-live`. Packed evidence records the package tarball, published
entrypoint resolution, and final bounded build inventory.

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
  workflow, viewport, or SDK imports change.
