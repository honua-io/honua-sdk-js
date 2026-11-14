---
type: reference
title: "Application Components Reference Workbench"
description: "The release reference is an installed-package, deterministic journey over the"
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
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

## Observation receipt: November 12, 2026

The automated evidence was rerun on SDK commit
`9ddd349c11cde4000379086ee21371e6dc2f8e71` before renewing the 90-day window.
All commands used the repository build-slot runner and prepared-build ownership
checks. The input digest was
`85b389d957b3e99f8cc48bfa4a32293f850721a92beec3126df625bc56d0365b`.

| Observation | Result | Run receipt |
| --- | --- | --- |
| Eight cited unit suites | 195 tests passed | `04d24afd-dbf3-40d9-9fcd-c2b1d86c6172` |
| Four cited Chromium suites, including CSP and WeakRef disposal | 13 tests passed | `d9ab87ad-a913-4837-963d-78e178052635` |
| Installed split-package consumers and both reference host lanes | Passed; first use 1,674 ms, interaction 1 ms, 10 DOM nodes, zero egress attempts | `66ffd2c6-699d-48d1-ab27-46a7d056e86b` |
| Published entrypoint bundle budgets | All 50 passed; web components 356.3 KiB gzip against the 401,337-byte ceiling | `npm run verify:bundle-budgets` |

The unit and browser builds had distribution digest
`67890b3eae311c2c3b2570359f3aaecf7f6e004d6ca07d7c39953306b7895e61`.
The installed-consumer run adopted the split-package build with digest
`2a2d74163e4e51d14c7b53a5e560c0bed2581e0c47d7e4b4c734bf73973556d4`.

Reproduce the observations before renewing the input timestamps, then run the
generator and drift check above:

```sh
npm test -- test/web-components-localization-german.test.ts test/web-components-rtl.test.ts test/web-components-csp.test.ts test/web-components-application-context.test.ts test/web-components-lifecycle-gates.test.ts test/offline-status.test.ts test/feature-inspection-qualification.test.ts test/web-components-feature-editor-element.test.ts
npm run test:playwright:prepared -- test/playwright/app-platform-reference-components.spec.mjs test/playwright/web-components-basic.spec.mjs test/playwright/web-components-csp.spec.mjs test/playwright/web-components-memory-leak.spec.mjs
npm run verify:split-packages:prepared
npm run verify:bundle-budgets
```

This renewal retains the five open component gates and the open retained-heap
budget. WeakRef collectibility does not measure retained bytes per cycle.
Accessibility qualification and the live-service lane have no new observations;
coverage remains the two named components and Chromium.

<!-- app-platform-reference-qualification:start -->

| Supported component | Maturity | Unit / contract | Browser artifact | Packed journey | Open gates |
| --- | --- | --- | --- | --- | --- |
| `honua-feature-inspection` | `production-tier` | 1 | 1 | 1 | 2 (`reference.automated-axe`, `reference.manual-screen-reader`) |
| `honua-feature-editor` | `production-tier` | 1 | 1 | 1 | 3 (`reference.automated-axe`, `reference.browser-functional`, `reference.manual-screen-reader`) |

Evidence observed **2026-11-12T19:16:30.625Z** and expires **2027-02-10T19:16:30.625Z**. The fixture is `packed` and zero-egress is `true`.

Live lane: `not-recorded` (gate: `HONUA_APP_PLATFORM_LIVE_ENABLED=true`).
Open budget gates: **1**.

Reference gates close only through their explicit `gateEvidence` mapping; generic file presence is not treated as proof.

[Machine-readable matrix](../config/app-platform-reference-qualification.v1.json) · [Executable packed workbench](../test/fixtures/packed-app-platform-reference-workbench.mjs)

<!-- app-platform-reference-qualification:end -->
