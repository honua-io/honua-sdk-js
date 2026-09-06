# Installed-package certification

`npm run certify:installed-package -- --execute-fixture` checks the installed
2026.1 package set against the digest in
`config/installed-package-certification.v1.json`. It exits nonzero until every
supported operation passes. A partial run is never a release certification.

Before installing or executing anything, the lane checks denominator drift and
freezes digests of the complete denominator, candidate package/server identities,
support profile, terminal journey, SQL fixture and executable fixture oracle.
All 72 non-counting rows remain visible; the 228 counting rows cannot pass via a
skip, an unknown ID or a missing scenario facet.

The isolated consumer installs all eight manifest packages with `npm ci`:
SDK, split SDK, Esri compatibility, React, geometry, app-platform and MCP at
`0.1.9-beta.0`, plus the independently versioned scaffold at `0.1.3`. The existing
published-release verifier checks tarball bytes, provenance and source revisions
for each package. Installation then checks exact registry URLs and SHA-512
integrity, rejects workspace links anywhere in the dependency tree, and rejects
nested copies of candidate packages at another version. The receipt includes the
complete dependency/peer resolution, lock digest, provenance results and exact
Node/npm/platform/architecture. No SDK is built or repacked by this lane.

`--execute-fixture` starts the exact candidate image with isolated PostGIS and
Redis. It verifies the running container's image ID before executing a standalone
consumer with public `@honua/sdk-js` imports. The FeatureServer fixture proves:

- Layer ID, name, geometry type, CRS and field metadata.
- Exactly five active features and zero matches for an absent name.
- Three bounded query pages, exact values and longitude/latitude ordinates.
- Null geometry and null attributes. Raster nodata is explicitly inapplicable.
- Exact request paths, statuses and a 128 KB response budget.

Expected values come from the SQL input VALUES, independently of SDK output. After
a successful baseline, the runner changes `alpha.ratio` from `1.25` to `999` in
PostGIS and requires the installed consumer's query assertion to fail. This
negative control is separate from the baseline observations. Containers and the
consumer directory are removed even on failure. This fixture uses loopback HTTP;
it is not the TLS, browser or authorization certification lane.

An external driver can supply `--observations <json>` instead. The input must be an
object with `schema: "honua.sdk-installed-observations/v1"`, a `binding` exactly
matching the frozen inputs, and an `observations` array. A pass must declare
installed execution, value assertions and every required facet. Old bare arrays
are rejected. This structural join does not authenticate arbitrary external
claims: only receipts from governed execution drivers may be submitted by the
release orchestrator. Other protocol, CLI/MCP, browser and lifecycle drivers
remain outstanding; a declared pass is not a substitute for those drivers.

The scheduled workflow preserves failed receipts and runs the executable fixture
when package identity passes. PR CI runs the bounded identity regressions and the
denominator drift check. Setup/identity failures emit `install.status: "failed"`
and attribute the unexecuted rows to this issue, rather than reporting passes.

## Current candidate blocker

The 2026-09-06 clean installation resolves:

```
@honua/sdk-js@0.1.9-beta.0
└── @honua/honua-migrate@0.1.3-beta.0
    └── @honua/sdk@0.1.2-beta.0
```

The migration forwarder is published separately, but its nested SDK still
participates in the installed product. It is outside the pinned `0.1.9-beta.0`
SDK set. The complete receipt in
`test-results/installed-package-certification.json` records the served tarball
URLs/integrities, verified provenance and this mismatch. Verdict: **not-certified,
0 passes, 228 blocked operations**. Fixing source or adding an npm override would
not repair those published bytes; a compatible published package set is required.

Issue #39 remains open. Full operation execution, browser/style proof, joined
CLI/MCP/Studio lifecycle receipts, negative authorization cases and release-side
consumption are not satisfied by this harness. The whole GP catalog and all four
cloud-native formats retain their required release scope. This PR does not
release or demote those promises.

`npm run certify:installed-examples` reuses package-set verification for the
example/snippet lane. Its previous executed quickstart budget failure remains
owned by #1584; this work does not change its budget or verdict.
