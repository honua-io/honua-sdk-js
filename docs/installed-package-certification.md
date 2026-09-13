---
type: reference
title: "Installed-package certification"
description: "`npm run certify:installed-package` is the hard 2026.1 client/server gate. It creates a clean temporary consumer,"
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
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

For a non-certifying check of the fixture oracle while package-set admission is
blocked, run `node scripts/diagnose-installed-fixture.mjs test-results/fixture-diagnostic.json`.
This still installs public package bytes and checks the root SDK's pinned integrity,
but deliberately cannot emit a certification-schema receipt. The retained diagnostic
at `test-results/installed-fixture-diagnostic.json` records three passing baseline
proofs and detection of the corrupted ratio. These do not change the certification
verdict or erase the package mismatch.

Issue #39 remains open. Full operation execution, browser/style proof, joined
CLI/MCP/Studio lifecycle receipts, negative authorization cases and release-side
consumption are not satisfied by this harness. The whole GP catalog and all four
cloud-native formats retain their required release scope. This PR does not
release or demote those promises.

`npm run certify:installed-examples` reuses package-set verification for the
example/snippet lane. Its previous executed quickstart budget failure remains
owned by #1584; this work does not change its budget or verdict.

## Native Windows replay

Both the certification and diagnostic installers use the repository's PATH-aware
npm launcher, preserving the host's npm/build-lock shim. A failed launch retains
its original error; a nonzero exit without stderr cannot become a pass or a
misleading `trim` exception. Callers retain control of subprocess timeouts.

To keep the isolated consumer and npm cache inside this Windows lane, run from
`C:\Users\mike\honua-io\wt-sdk-js-39-candidate-proof` in PowerShell:

```powershell
$env:TEMP = Join-Path (Get-Location) 'test-results'
$env:TMP = $env:TEMP
$env:npm_config_cache = 'C:\Users\mike\honua-io\.npm-cache'
node scripts/installed-package-certification.mjs --execute-fixture --output test-results/installed-package-certification.windows.json
```

The 2026-09-13 pre-fix replay is retained in
`test-results/installed-package-certification.windows-before.json`: admission
failed with `Cannot read properties of undefined (reading 'trim')`, before any
operation executed. The corrected replay is retained separately so neither run
replaces the earlier candidate evidence.

Prior work was fetched from `test/1328-exact-candidate-receipt` (closed #1581)
and the newer matching `test/39-candidate-proof` / `wip/test/39-candidate-proof`
checkpoint. The latter's #1646 implementation is already on trunk and is retained.
The former's standalone OGC observation adapter predates the frozen-envelope
contract: it projects `result: passed` without the required per-row assertion and
scenario-facet evidence. Restoring that adapter would not meet current acceptance;
the retained OGC qualification collector remains available, and no historical
OGC result is promoted into the new installed receipt.

The corrected 2026-09-13 clean installation completed on Windows x64 with Node
24.7.0 and npm 11.5.1. All eight direct package provenance checks passed. Admission
then rejected `node_modules/@honua/honua-migrate/node_modules/@honua/sdk` at
`0.1.2-beta.0` (expected `0.1.9-beta.0`). The full dependency resolution, frozen
identities and provenance are retained in
`test-results/installed-package-certification.windows.json`, receipt digest
`sha256:d9a46f099cf9d31bf0cc314cde12e6e8dd919b2d2745d61b5118ef1b34dd9291`.
It reports **not-certified: 0 pass, 0 fail, 228 blocked** and exits 1. No server
fixture or supported operation ran after this package-set rejection.

Native validation: `npm run check` passed; the denominator check found no drift;
59 certification/identity/fixture/workflow regression tests passed with zero
skips. The package mismatch is a published-byte blocker, not a Windows launcher
failure. Compatible published packages, complete operation/browser/authorization/
journey proofs and release-side consumption remain required for #39 closure.
