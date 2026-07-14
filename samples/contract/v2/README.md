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
`planned` is deliberately not evidence and makes no live-success claim.

Golden journey IDs are stable roadmap slots, not automatic quality claims.
Each declares a `planned` or `qualified` status and one candidate sample. A
planned candidate remains a recipe or lab. Promotion to the golden track
requires supported and active lifecycle state, executed fixture evidence, and
current executed live evidence whenever its quality profile requires it.

CI commands preserve execution semantics. Bounded validation actions are
`automatic`; fixture services and setup are `orchestrated`; live-evidence
producers are `scheduled-only`. Consumers must never flatten those groups or
run `*:mock`/live producers as unconditional pull-request steps. Profile gates
remain the selection contract for the shared runner in #541.

Configuration metadata distinguishes approved environment-name surfaces,
samples needing no configuration, and `legacy-unsafe` gaps. A legacy-unsafe
sample must have bounded rework and cannot invent approved variable names. The
Cesium route lab is explicitly in that state until its URL-query endpoint and
ion-token inputs are replaced.

Lifecycle states other than `active` have a target release. `merge`, `replace`,
and `retire` also identify a non-self sample, golden journey, or typed external
replacement. Validation fails when the package reaches a target release while
the transition remains unresolved.

The v1 catalog and projection remain committed as frozen compatibility inputs
for consumers that have not yet moved to v2. In-repository generators, learning
paths, flagship evidence validation, and new site/CI projections consume v2.

Run:

```bash
npm run samples:migrate:v1 # reproduce catalog.v2.json
npm run samples:generate   # write generated docs and projections
npm run samples:verify     # validate inventory, evidence, and output drift
```
