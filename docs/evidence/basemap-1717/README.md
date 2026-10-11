---
type: reference
title: "Basemap development bundle evidence"
description: "Reproducible installed-package measurements for the free basemap implementation."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Basemap development bundle evidence

The optimized source is `97c6bb6e60c32bdf61edca6e5b77c72c7d2e083a`, measured from a clean worktree with a verified prepared SDK build. The [installed consumer receipt](pr2010-first-map-final.json) and [consumer lock](pr2010-first-map-final.consumer-lock.json) retain the complete measurement. This is packed-development evidence, not published-release certification.

All 121 non-SDK dependency identities remain fixed against the historical lock, including MapLibre 6.13.0 and its integrity. Runtime, worker and stylesheet resolve inside the isolated consumer; the bundle contains one MapLibre runtime.

| Measurement | Actual bytes | Ceiling bytes | Headroom bytes |
| --- | ---: | ---: | ---: |
| First Map emitted JavaScript | 1,969,286 | 1,990,000 | 20,714 |
| First Map emitted JavaScript gzip | 523,861 | 524,000 | 139 |
| Runtime entrypoint gzip | 184,885 | 203,374 | 18,489 |

Renderer protocol loading now preserves tree shaking, basemap private state is consolidated, and generated map-package required checks are compacted with diagnostic-equivalence regressions. First Map saves 37,412 raw and 8,459 gzip bytes against the historical measurement without changing those ceilings. The separate runtime entrypoint exceeded its old 184,699-byte gzip ceiling by 186 bytes; its approved reset follows the repository policy `ceil(actual * 1.1)`. The canonical report is regenerated in `docs/bundle-sizes.md`.

The same receipt preserves a **failed local CPU-profile check**: this WSL Intel Core Ultra 7 host has no `ubuntu24` runner-image identity and is not the calibrated GitHub Actions AMD EPYC runner. Its three cold-context, 4x-throttled measurements have medians of 465.364 ms script CPU and 161.633 ms parse/compile, above the calibrated limits of 175/110 ms. The receipt's overall failed status must not be presented as a CPU pass. The PR's calibrated CI execution lane supplies that separate required verdict; the local emitted-byte and installed-peer checks pass.

The [packed starter receipt](pr2010-create-app-sdk-pair.json) records both vanilla and React templates typechecking and building under default peer resolution against the development tarball and published SDK 0.1.14. The older SDK executes the actionable upgrade-message path. Both the deterministic basemap browser test and the opt-in live OpenFreeMap availability test passed on this implementation.

## Historical failed measurement

Source `5d64e59832e0174a071170843c05dfb288d017e8` was also measured from a clean worktree. Its SDK build was admitted from [producer run 38141546837](https://github.com/honua-io/honua-sdk-js/actions/runs/38141546837), artifact `11703565016`, with source and build-input identities verified.

The [historical First Map receipt](basemap-first-map-5d64.json) and [consumer lock](basemap-first-map-5d64.consumer-lock.json) preserve that failed packed-development measurement. They do not certify a published release.

| Measurement | Actual bytes | Then-current ceiling bytes | Excess bytes |
| --- | ---: | ---: | ---: |
| First Map emitted JavaScript | 2,006,698 | 1,990,000 | 16,698 |
| First Map emitted JavaScript gzip | 532,320 | 524,000 | 8,320 |
| Runtime entrypoint gzip | 184,705 | 184,699 | 6 |
