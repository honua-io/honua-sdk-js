# Sample publication contract v2

Catalog v2 is the canonical inventory for runnable SDK samples. It separates a
sample's product track, support tier, lifecycle state, validation profile, and
execution evidence so none of those meanings has to be inferred from another.

- `samples/catalog.v2.json` inventories every runnable application under
  `examples/` and `docs/examples/`. A runnable root application has an
  `index.html`, `package.json`, or `src/server.ts` marker; reserved `_`-prefixed
  infrastructure directories are excluded. A runnable docs application has
  both `index.html` and an `app.js`, `app.mjs`, or `app.ts` entry file.
- `sample-catalog.schema.json` defines the four tracks (`golden`, `recipe`,
  `lab`, and `fixture`), the seven reserved golden journey IDs, lifecycle
  targets, evidence declarations, and named validation profiles.
- `sample-ci-selection.schema.json` describes the generated, command-safe CI
  projection consumed by `scripts/sample-runner.mjs`. The runner checks that
  the projection is an exact, current derivation of the catalog before it
  executes any command.
- `site-projection.schema.json` contains presentation-safe metadata for every
  catalog entry and the existing route migration map. Commands, configuration
  names, credential material, and executable source are not copied to the site.
- `capability-sample-matrix.schema.json` defines the generated support-to-sample
  coverage contract. `samples/dist/capability-sample-matrix.v1.json` joins the
  support manifest, exact package exports, catalog v2, and validated golden
  qualification receipts without creating another support inventory.
  Its compact fixture has a companion adversarial fixture that pins orphan,
  stale, and overstated-join rejection cases.
- `golden-journey-visual-evidence.schema.json` defines the SDK-owned visual
  evidence handoff. `samples/dist/golden-journey-visual-evidence.v1.json`
  contains only catalog-qualified journeys and binds desktop/mobile captures,
  the exact Playwright project and browser runtime, every semantic gate
  receipt, artifact integrity, and the shared freshness window. Site consumer
  routes and presentation remain a separate consumer concern.
- `site-consumer-handoff.schema.json` defines that separate consumer boundary.
  `samples/dist/honua-site-consumer-handoff.v1.json` content-binds the site
  projection, capability matrix, and golden visual evidence; projects public
  cards and visible gaps; declares task, capability, protocol, and supporting
  facets; and resolves every canonical, legacy, replacement, and retirement
  route without copying executable source. The generated v3 consumer fixture
  pins the artifact digest and executes representative filter cases plus the
  required accessible keyboard and desktop/mobile responsive behavior. Both
  artifacts publish closed collection, string, JSON-depth, and byte budgets;
  the fixture separately exercises positive text and zero-result searches.
- `sample-bundles.schema.json` defines the static browser bundles published for
  the samples gallery to embed. The manifest is not committed: it is built into
  `.artifacts/sample-bundles/sample-bundles.v2.json` and published as a rolling
  GitHub Release asset. Alongside per-file SHA-256/SRI integrity and the build
  commit, every entry carries the publication truth a consumer needs to embed a
  bundle honestly -- support tier, lifecycle, the browser-public config surface,
  and whether the bundle runs `standalone` or only where the host serves its
  declared `hostFixtureRoutes`. Format v2 (honua-io/honua-sdk-js#656) retires
  v1; see [`docs/sample-bundles.md`](../../../docs/sample-bundles.md).
- `migrations/catalog.v1-to-v2.json` is the reviewed one-time migration overlay.
  `npm run samples:migrate:v1` reproduces `samples/catalog.v2.json` from the
  frozen v1 catalog and this overlay.
- Every entry also carries `capabilityKeys`: the canonical honua-server
  `capability-keys.v1.json` keys its `capabilities` slugs crosswalk to, via
  `config/capability-crosswalk.v1.json`. See
  [`docs/capability-keys.md`](../../../docs/capability-keys.md) for the
  crosswalk, validation, and the companion `sdk-coverage.v1.json` snapshot.

Live status is evidence-bound. A catalog entry cannot declare live `executed`,
`skipped`, `credential-unavailable`, or `failed` without a matching versioned
evidence envelope and an expiry. Expired evidence fails `samples:verify`.
`observedAt` cannot be more than five minutes ahead of the validation clock,
and provenance observation time cannot follow the envelope observation beyond
that same skew. `planned` is deliberately not evidence and makes no
live-success claim.

Golden journey IDs are stable roadmap slots, not automatic quality claims.
Each declares a `planned` or `qualified` status and one candidate sample. A
planned candidate remains a recipe or lab. Promotion to the golden track
requires supported and active lifecycle state, executed fixture evidence, and
current executed live evidence whenever its quality profile requires it.
All seven candidates are currently planned; the catalog makes no golden claim
until #541 supplies verifiable gate, screenshot, performance, fixture, and live
evidence. Validation fails closed on every attempted golden promotion until
those versioned per-gate receipts exist; profile booleans alone are never proof.

Matrix support and sample coverage are deliberately separate. A supported SDK
cell remains supported when it lacks a qualified sample; its coverage is shown
as `planned` or `partial`, not silently promoted or downgraded. Beta and
experimental SDK cells remain `experimental`, default protocol gaps remain
`unsupported`, and only a catalog-qualified golden sample with its complete
validated receipt set can produce `qualified`. The projection contains no
wall-clock generation value and hashes all four authority inputs, so identical
inputs produce identical bytes.

Qualified matrix cells resolve through content-derived evidence-binding IDs.
Each binding names canonical SDK source at one evidence-neutral revision and
digest, at least one source-mode receipt, and the packed-build receipt and
report with their byte and SHA-256 bindings. Matrix generation validates the
complete receipt semantics and exact evidence directory/run inventory, then
rejects orphan sample trees, unreferenced runs, expired receipts, missing or
changed reports, and protocol/claim/entrypoint joins that overstate the
catalog. Freshness fields are copied only from the signed receipts; the matrix
does not add an observation or generation clock. With no qualified journeys,
the canonical matrix has zero receipts, zero evidence bindings, and no
qualified cells.

The site consumer handoff preserves that qualification boundary. Every
matrix-qualified public sample must appear as one canonical card with its
source/packed evidence binding and matching current visual evidence; the
Incident Operations journey additionally requires a positive realtime
observation window. An empty qualified set is valid when the authority inputs
contain no admitted receipt set. Empty public cards are never valid. Legacy
SDK routes resolve to `samples/<sample-id>.html`; internal fixtures and
site-owned exceptions require an explicit status page instead of a substitute
application. Canonical `retire` and `replace` routes are lifecycle status pages,
while their legacy aliases remain permanent redirects to that status. External
listings may use only canonical paths. The interaction
object is a downstream requirement, not evidence that `honua-site` has already
implemented or deployed it; that repository must validate the v3 fixture and
run its own static/accessibility/responsive build before adoption is complete.

Publication admission is fail-closed on four further conditions, and each one
is checked against what the handoff itself publishes so a consumer can reproduce
the decision from the handed-off bundle alone.

- Golden-card receipts must be current. `policy.qualifiedRequires` is machine
  checked per qualified card rather than read as prose: the source identity has
  to match the card's own executable path and carry a full revision and
  evidence-neutral digest, `packed-build` has to come from the packed SDK mode,
  the `fixture` and `live` gates have to be present with a live observation
  window, both the desktop and the mobile capture have to be present at their
  required viewport and byte-identical across the repeat capture, and all nine
  semantic gate receipts have to appear in canonical order. Every aggregate,
  per-gate, and live freshness window is re-evaluated against the validation
  clock, so an expired receipt fails publication instead of shipping a stale
  card.
- Identities may never be duplicated. Two cards may not share a canonical route,
  an executable source path, a golden journey, an evidence binding, or a visual
  evidence sample, and the upstream projection, matrix, and visual-evidence
  inventories may not repeat a journey, replacement, evidence-binding, or
  journey/sample identity. This is what keeps a second implementation from
  riding an already-qualified card's evidence.
- Published evidence must dereference. Every screenshot, repeat capture, gate
  receipt, and gate report a card advertises has to resolve inside the owning
  sample's own `samples/evidence/<sample-id>` root and its own evidence run, as
  a regular non-symlink file whose bytes and digest match the published
  reference. A missing file, a replaced file, a stale digest, or a path that
  reaches into another sample's evidence fails publication.
- The handoff must stay versioned, and the version pin has to be immutable. Each
  reference content-addresses the schema that governs it with `schemaBytes` and
  `schemaSha256`, exactly as it already content-addresses the artifact with
  `bytes` and `sha256`; validation recomputes the digest from the schema on disk
  and fails publication on mismatch. The schema's own `$id` (a canonical
  `https://honua.io/schemas/sdk/` identifier ending in the referenced schema
  version) and its `format`/`schemaVersion` constants are still checked, but only
  as a guard against a reference pointed at the wrong or a renamed schema: a
  schema declares those about itself, so they cannot detect a schema edited in
  place while keeping its version. The digest can, whether the edit weakened a
  constraint or only reformatted the file. `handoff.inputs` pins the three
  upstream authority schemas and the v3 consumer fixture's `input` pins the
  handoff's own schema, so all four contract schemas a consumer depends on are
  bound. A reference published before this binding existed carries no schema
  digest; under the relax flag below that counts as pending regeneration, and a
  strict run rejects it rather than treating it as verified.

The file-dereferencing and schema-pinning checks require a checkout and are
consequently deferred at pull-request time by the derived-artifact decoupling
(`HONUA_DERIVED_ARTIFACTS_RELAX`, honua-io/honua-sdk-js#677), exactly like the
existing source and docs link checks. The receipt-currency and duplicate-identity
checks are pure metadata and always run. Legitimately pending coverage stays
publishable: an honest `planned`, `partial`, `experimental`, or `unsupported`
card carries no evidence binding and no visual evidence, and only overstated
claims fail.

CI commands preserve execution semantics. Bounded validation actions are
`automatic`; fixture services and setup are `orchestrated`; live-evidence
producers are `scheduled-only`. Consumers must never flatten those groups or
run `*:mock`/live producers as unconditional pull-request steps. Profile gates
remain the selection contract for the shared runner. Every command is
validated as a whole: either an exact `npm run <repository-script>` invocation
or a one-file Playwright/Vitest invocation through the repository-installed
tool. Shell metacharacters, arguments, arbitrary `npx` packages, path traversal,
and unbounded Vite development servers are rejected. Scheduled live commands
are limited to an exact reviewed registry that pins each producer's repository
script definition and generator path; automatic validation uses its own
positive registry and bounded definition grammar. A safe-looking script suffix
is not sufficient in either lane.

Configuration metadata is an exact static inventory of named `process.env`,
`import.meta.env`, Node loader `env.NAME`, and literal-key helper reads in each
sample source tree. Scoped `process.env` aliases, bounded defaults, fixed
destructuring, and finite dynamic helper call chains are resolved regardless of
parameter names. Unbounded computed reads, environment rest destructuring,
exported dynamic readers, and reader aliases fail closed. A whole
`import.meta.env` occurrence is always unsafe because Vite can serialize every
available `VITE_*` value even when a local callee reads one field; approved and
not-required samples must use explicit named projections. Other whole
environment escapes also require `legacy-unsafe` status and bounded rework,
without hiding the names that static analysis can inventory. Validation rejects
missing and invented names. The only exempt reads are the explicitly declared
Vite `MODE` and GitHub Actions `GITHUB_SHA` built-ins. Each retained name is
classified as browser-public or server-only and as non-secret or credential;
credentials include token, API/access/private keys, client secrets, and
password names, and additionally identify public-token versus secret scope.
Browser-public credentials force
`legacy-unsafe` status and bounded rework, even when the credential is a public
Mapbox token. Legacy status never hides observed names. The Cesium route lab is
also explicitly legacy-unsafe with an empty environment inventory because its
remaining unsafe inputs are URL-query parameters.
`credentialQueryParameters` is the canonical normalized deny-list shared by the
catalog, generated projections, and evidence-envelope URL validator; catalog
drift, user information in any valid `scheme://` URL, or a matching query key
fails verification. Credential-shaped bearer/JWT values, correctly formed AWS
access-key identifiers, private-key headers, and non-placeholder credential
assignments with token-like lengths also fail before publication. Query names
are NFKC-normalized, split at camel-case boundaries, lowercased, and reduced to
underscore-delimited tokens before exact or token-boundary suffix matching.
Ordinary words that merely contain `key`, `token`, `secret`, or `signature`
remain valid. Property names participate in the same scan; normalized sensitive
properties accept only declarative placeholders or configuration-name
references. Traversal rejects cycles and is bounded to 64 levels and 50,000
nodes before any schema engine sees programmatic input.

Every mock-server Vite build uses the shared fixture environment boundary. It
preserves non-browser build controls, removes all inherited `VITE_*` values,
then applies only the harness's explicit fixture overrides. A structural gate
covers all 25 launchers and rejects default process inheritance, direct
`process.env`, or an omitted child `env` option.

Executed live evidence carries a full reported source revision plus a
`producer-generator` artifact. Verification content-binds that artifact to the
one unambiguous declared live command, that command's reviewed generator path,
and the current SHA-256 bytes for every producer. Path identity is checked
before content digest; a different repository file or another reviewed
generator cannot satisfy the command. The benchmark generator additionally
proves that it names the sample and journey. The reported revision is metadata,
not by itself a claim that arbitrary catalog evidence was read from or attested
by that Git commit. Receipt production adds the stronger qualification
boundary: the runner supplies a named source revision to the producer, requires
fresh evidence at its per-run output path, and accepts that revision only when
it exists, has the same evidence-neutral source tree, and is an ancestor of the
checkout being used to validate the receipt. Non-executed evidence may report a
null revision and may omit a producer claim, but any producer artifact it does
publish is subject to the same exact command, path, digest, sample, and journey
binding.

Lifecycle states other than `active` have a target release. `merge`, `replace`,
and `retire` also identify a non-self sample, golden journey, or typed external
replacement. Validation fails when the package reaches a target release while
the transition remains unresolved.

The v1 catalog and projection remain committed as frozen compatibility inputs
for consumers that have not yet moved to v2. In-repository generators, learning
paths, flagship evidence validation, and new site/CI projections consume v2.
Generated projections are byte-bound to the effective package version; a
package-version change requires regeneration of the tracked site projection,
capability matrix, and consumer digest.

Run:

```bash
npm run samples:migrate:v1 # reproduce catalog.v2.json
npm run samples:generate   # write generated docs and projections
npm run samples:verify     # validate inventory, evidence, and output drift
npm run samples:list -- --kit # inspect kit-managed samples
npm run samples:run -- verify --kit --sdk-mode source
npm run samples:run -- verify --kit --sdk-mode packed
```

Gate qualification is receipt-based. `samples:run evidence` captures a clean,
evidence-neutral source digest before launching a producer. It rejects
skip-worktree and assume-unchanged inputs; binds the index, `HEAD`, and named
source revision to the same digest; and requires the named revision to remain an
ancestor of `HEAD`. This permits an evidence-only descendant commit while
rejecting unrelated or source-changing revisions. Existing
`samples/evidence` state is content-bound before execution.

The first promotion of a candidate uses an explicit, fail-closed bootstrap. Run
the complete evidence command once while the candidate is still planned, then
promote the catalog and point its live lane at that executed envelope. Generate
the migrated catalog with
`npm run samples:migrate:v1 -- --qualification-bootstrap <sample-id>` and the
projections with
`npm run samples:generate -- --qualification-bootstrap <sample-id>`, commit the
evidence-neutral source tree, and run the complete evidence command again. If
the candidate appears in the generated learning paths, regenerate those with
`npm run docs:learning:generate -- --qualification-bootstrap <sample-id>` before
the source commit. The bootstrap skips only the named golden sample's existing
receipt set; catalog, live-envelope, profile, and journey validation still run,
and the normal `samples:verify` gate requires receipts bound to the final
committed source.

Each command group receives a fresh canonical
`samples/evidence/<sample>/runs/<lowercase-uuid-v4>` root. Its receipts require
that exact `runRoot`, and every generated artifact is checked
component-by-component as a regular, non-symlink descendant. Only current
receipt paths and that run may change. All receipts co-produced by one command
are validated before a complete receipt tree is staged and directory-swapped
into place. Publication failures restore the prior tree, and qualification
requires each expected command group to share one `runRoot`; separately
executed commands retain separate roots. Replacing a command group's receipts
preserves all runs still referenced by any receipt; cleanup prunes only
unreferenced UUID runs left by obsolete or failed attempts. A successful live
gate also atomically publishes the validated envelope to
`samples/evidence/<sample>/live.v1.json`; catalogs reference that stable path,
never a prunable UUID run directory. Because the source
digest excludes only the canonical evidence tree, committed receipts can be
validated after promotion without recursively hashing themselves.

Browser receipts are bound to the exact pilot test, every declared project and
browser engine, first-attempt results, and finalized assertion attachment sets.
The runner validates the raw Playwright checkout root and project test roots,
then publishes the canonical repository-relative `test/playwright` binding;
producer-machine worktree paths and volatile output directories are never part
of committed evidence; the raw reporter file is discarded after the canonical
per-gate wrappers are written.
Console assertions are finalized after quality checks, fixture teardown, and
explicit closure of the pilot-owned page and browser context.
Screenshot receipts capture an ordered 1280x720 desktop and 390x844 mobile pair
twice in one page session after fonts, scroll origin, and two animation frames
stabilize. Byte equality is claimed only inside that pinned session and records
the exact Playwright version, project, browser name/version, platform, and
architecture; it is not a cross-platform equivalence claim. Verification
rejects aliased primary/repeat paths and rechecks both PNG structures,
dimensions, byte counts, and SHA-256 digests. Performance receipts come from
that same browser workflow and bind positive monotonic
navigation/resource/interaction measurements, sample-ready measurement, and
budget. Fixture receipts prove loopback
readiness, a real probe, and zero listeners or connections after shutdown.
Packed receipts bind the package tarball and re-read a self-contained copy of
the final sample `dist` tree and resolution evidence from the same run. Live
receipts require the reviewed producer to honor the runner's explicit enable
flag, write a fresh envelope to the runner-provided per-run path, and reject
exact forwarded credential values in the envelope or any declared artifact. See
[`examples/_kit/README.md`](../../../examples/_kit/README.md) for runner usage.

## Release-matrix browser evidence (honua-io/honua-sdk-js#766)

Per-gate `browser` receipts only ever prove the default Playwright lane, which
is Chromium-only. Cross-engine outcomes come from the release-only First Map
smoke (`.github/workflows/first-map-release-smoke.yml`), which runs the
quickstart spec across Chromium, headless WebKit, and headed Firefox under a
virtual display with `HONUA_FIRST_MAP_RELEASE_MATRIX=true`.

- `sample-release-matrix-receipt.schema.json` defines that lane's receipt,
  sealed to `samples/evidence/<sample>/release-matrix.v1.json` by
  `scripts/seal-release-matrix-receipt.mjs`. It is a separate receipt type from
  `sample-gate-receipt.schema.json` on purpose: gate receipts are
  `status: "passed"` by construction, while a matrix receipt must be able to
  publish a FAILURE, because the failure is the signal that makes the golden
  qualification stale. It records per-engine status, test and failure counts,
  durations, the release-matrix environment, the workflow run identity, the
  evidence-neutral whole-tree digest and revision, and the SHA-256 of the raw
  Playwright report retained as the release smoke's workflow artifact.
- The sidecar sits beside `receipts/`, never inside it: that directory must
  contain exactly the quality profile's per-gate receipts. It is declared in the
  strict evidence-root inventory, so an undeclared sidecar is still an orphan.
- Persistence has no separate commit path. The release smoke seals the receipt
  on every run, green or red, uploads it, and dispatches
  `regenerate-derived-artifacts.yml`, which downloads it, verifies it is bound
  to the dispatching run, installs it, and lands it through the same protected,
  path-validated evidence-reseal automation as every other generated artifact.
- Freshness mirrors the gate-receipt policy exactly: `observedAt` plus seven
  days, no new cadence. `samples:verify` treats a **failing** receipt as an
  error everywhere except the publication automation
  (`HONUA_RELEASE_MATRIX_RECEIPT_RELAX`, which reports instead of enforcing so
  the automation can commit the failing receipt), and an **expired** one as an
  error in strict lanes while reporting it wherever
  `HONUA_DERIVED_ARTIFACTS_RELAX` already relaxes shared derived-artifact
  freshness. Re-running `first-map-release-smoke.yml` reseals the lane and
  restores qualified status with no manual edit.
- The qualification record projects the lane into the generated catalog,
  [`docs/generated/sample-catalog.md`](../../../docs/generated/sample-catalog.md):
  one row per established lane with its last sealed outcome, per-engine status,
  freshness window, and receipt path. The section is emitted only once a lane is
  established or a receipt exists, so the generated bytes are unchanged until the
  first release smoke lands.
- It is deliberately NOT published into
  `samples/dist/golden-journey-visual-evidence.v1.json`. That artifact's schema is
  content-addressed by the committed consumer handoff
  (`inputs.visualEvidence.schemaBytes`/`schemaSha256`,
  honua-io/honua-sdk-js#791), so adding even an optional property to it is a
  versioned contract change: `golden-journey-visual-evidence.schema.json` would
  have to bump v1 to v2, `site-consumer-handoff.schema.json` and
  `site-consumer-fixture.schema.json` would have to bump with it because they pin
  the visual-evidence `format` const, every committed projection and consumer
  fixture would have to be regenerated in the same change, and honua-site would
  have to move to the new format strings. That transition belongs to a dedicated
  bump carried by the derived-artifact automation, not to a feature branch that
  cannot legitimately reseal the committed artifacts.

### Lane establishment is recorded outside the evidence tree

An **absent** receipt is not evidence of anything, so before a lane is
established it is only a note: `samples:verify` cannot go red for cross-browser
evidence that has never been produced. Establishment itself, however, must not be
erasable by deleting the evidence, or a failing lane could be laundered back to
that harmless note.

- `release-matrix-lanes.v1.json` (schema: `sample-release-matrix-lanes.schema.json`)
  is the reviewed registry of established lanes. It records `sampleId`, the
  canonical `receiptPath`, the first receipt's `establishedAt`, and the workflow
  run that produced it. Absence of the file means no lane has ever been
  established.
- It lives under `samples/contract/`, **inside** the evidence-neutral source
  digest, while the receipt lives under `samples/evidence/`, which is outside it.
  That asymmetry is the point: removing a sealed receipt cannot relax the
  requirement, because the requirement is reviewed contract source that the
  digest, code review, and CI all cover.
- `npm run samples:release-matrix:record -- --sample <id>` writes it from the
  sealed receipt. `regenerate-derived-artifacts.yml` runs it in the same slot as
  `samples:refresh-live-expiry` -- after a reseal pass, before the catalog
  commit -- so establishment lands in the SAME automation commit chain that
  publishes the first receipt, and so the following reseal binds to a tree that
  already contains it. It is idempotent and pins `establishedAt` to the first
  receipt, so later regenerations write no bytes and cause no digest churn.
- Once a lane is recorded, a missing sidecar carries exactly the same severity as
  a failing engine: an error in every enforced lane, downgraded only by the
  publication automation's `HONUA_RELEASE_MATRIX_RECEIPT_RELAX`. The generator
  side is stricter still and is never relaxed -- `collectQualificationEvidence`
  requires the declared sidecar to exist, so no projection can present an
  established lane as qualified after its evidence was removed. Resealing with
  `first-map-release-smoke.yml` is the only way back to green.
