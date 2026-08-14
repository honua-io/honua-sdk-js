# Application Components Reference Workbench

The release reference is an installed-package, deterministic journey over the
supported application owners. It resolves a protocol-neutral `Source`, builds
the map/controller state, inspects a map hit, filters the bounded table,
commits an edit, refreshes the table, and exports reviewed state. It imports
only `@honua/sdk`, `@honua/app-platform`, React, and React DOM from the split
package consumer; imports from `src/` and `@honua/sdk-js` are rejected by the
qualification verifier.

The fixture installs a rejecting fetch implementation before application code
runs, and the journey fails if any egress is attempted. The React lane renders
the same registered custom element used by the direct lane; both join the
single application context. Locale/RTL, authorization replacement, stale,
degraded, offline, failed, and realtime states use the shared shell rather than
sample-local replacement state.

Run the source-of-truth and drift checks with:

```sh
npm run qualification:app-platform
npm run qualification:app-platform:check
npm run verify:split-packages
```

`config/app-platform-reference-evidence.v1.json` is the reviewed evidence
input. `config/component-qualification.v1.json` remains the maturity authority.
The generator joins them and fails on missing component evidence, maturity
contradictions, missing files, an incomplete journey/state/budget inventory,
an overstated live lane, evidence older than its expiry, or a bundle ceiling
that disagrees with `bundle-budgets.json`.

The default browser lane is Chromium, matching `playwright.config.mjs`. Live
protocol evidence is deliberately separate and remains `not-recorded` until a
run gated by `HONUA_APP_PLATFORM_LIVE_ENABLED=true` records endpoint, version,
auth mode, observation date, expiry, and receipt paths.

<!-- app-platform-reference-qualification:start -->

| Supported component | Maturity | Unit / contract | Browser artifact | Packed journey | Open gates |
| --- | --- | --- | --- | --- | --- |
| `honua-feature-inspection` | `production-tier` | 1 | 1 | 1 | 2 (`reference.automated-axe`, `reference.manual-screen-reader`) |
| `honua-feature-editor` | `production-tier` | 1 | 1 | 1 | 3 (`reference.automated-axe`, `reference.browser-functional`, `reference.manual-screen-reader`) |

Evidence observed **2026-08-14T12:00:00.000Z** and expires **2026-11-12T12:00:00.000Z**. The fixture is `packed` and zero-egress is `true`.

Live lane: `not-recorded` (gate: `HONUA_APP_PLATFORM_LIVE_ENABLED=true`).
Open budget gates: **1**.

Reference gates close only through their explicit `gateEvidence` mapping; generic file presence is not treated as proof.

[Machine-readable matrix](../config/app-platform-reference-qualification.v1.json) · [Executable packed workbench](../test/fixtures/packed-app-platform-reference-workbench.mjs)

<!-- app-platform-reference-qualification:end -->
