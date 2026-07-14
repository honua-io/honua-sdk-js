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
- `migrations/catalog.v1-to-v2.json` is the reviewed one-time migration overlay.
  `npm run samples:migrate:v1` reproduces `samples/catalog.v2.json` from the
  frozen v1 catalog and this overlay.

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
catalog and evidence-envelope URL validator; catalog drift or a matching query
key fails verification. Query names are NFKC-normalized, split at camel-case
boundaries, lowercased, and reduced to underscore-delimited tokens before exact
or token-boundary suffix matching. Ordinary words that merely contain `key`,
`token`, `secret`, or `signature` remain valid.

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
not a claim that the current bytes were read from or attested by that Git
commit. Non-executed evidence may report a null revision and may omit a producer
claim, but any producer artifact it does publish is subject to the same exact
command, path, digest, sample, and journey binding.

Lifecycle states other than `active` have a target release. `merge`, `replace`,
and `retire` also identify a non-self sample, golden journey, or typed external
replacement. Validation fails when the package reaches a target release while
the transition remains unresolved.

The v1 catalog and projection remain committed as frozen compatibility inputs
for consumers that have not yet moved to v2. In-repository generators, learning
paths, flagship evidence validation, and new site/CI projections consume v2.
Generated projections are byte-bound to the effective package version; a
package-version change requires regeneration of both the tracked site
projection and its consumer digest.

Run:

```bash
npm run samples:migrate:v1 # reproduce catalog.v2.json
npm run samples:generate   # write generated docs and projections
npm run samples:verify     # validate inventory, evidence, and output drift
npm run samples:list -- --kit # inspect kit-managed samples
npm run samples:run -- verify --kit --sdk-mode source
npm run samples:run -- verify --kit --sdk-mode packed
```

Gate qualification is receipt-based. `samples:run evidence` captures a clean
source snapshot before launching a producer, preserves and content-binds the
tracked `test-results` baselines, writes one versioned receipt for each required
profile gate, and rejects stale, missing, extra, metadata-only, or
source-unbound evidence. Browser receipts are bound to the exact pilot test,
project, first-attempt result, and assertion attachment set. Fixture receipts
prove loopback readiness, a real probe, and zero listeners or connections after
shutdown. Packed receipts bind the package tarball and re-read the final bounded
dist tree and resolution evidence. See
[`examples/_kit/README.md`](../../../examples/_kit/README.md) for runner usage.
