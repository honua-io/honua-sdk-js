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
  projection. It is the handoff to the shared runner tracked by #541; it does
  not implement that runner.
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
evidence.

CI commands preserve execution semantics. Bounded validation actions are
`automatic`; fixture services and setup are `orchestrated`; live-evidence
producers are `scheduled-only`. Consumers must never flatten those groups or
run `*:mock`/live producers as unconditional pull-request steps. Profile gates
remain the selection contract for the shared runner in #541. Every command is
validated as a whole: either an exact `npm run <repository-script>` invocation
or a one-file Playwright/Vitest invocation through the repository-installed
tool. Shell metacharacters, arguments, arbitrary `npx` packages, path traversal,
and unbounded Vite development servers are rejected. Scheduled live commands
are limited to an exact reviewed registry that also pins each producer's
repository script definition; automatic validation uses its own positive
registry and bounded definition grammar. A safe-looking script suffix is not
sufficient in either lane.

Configuration metadata is an exact static inventory of named `process.env`,
`import.meta.env`, Node loader `env.NAME`, and literal-key helper reads in each
sample source tree. Finite aliases, destructuring, and dynamic helper call
chains are resolved; unbounded computed reads, environment rest destructuring,
exported dynamic readers, and reader aliases fail closed. Validation rejects
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

Executed live evidence carries a full reported source revision plus a
`producer-generator` artifact. Verification content-binds that artifact to the
current repository path and SHA-256 bytes for every producer; the benchmark
generator additionally proves that it names the sample and journey. The
reported revision is metadata, not a claim that the current bytes were read
from or attested by that Git commit. Non-executed evidence may report a null
revision.

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
```
