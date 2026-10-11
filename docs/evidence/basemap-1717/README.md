---
type: reference
title: "Basemap development bundle evidence"
description: "Reproducible installed-package measurements for the free basemap implementation."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Basemap development bundle evidence

Measured source: `5d64e59832e0174a071170843c05dfb288d017e8`, clean worktree.
The SDK build was admitted from [producer run 38141546837](https://github.com/honua-io/honua-sdk-js/actions/runs/38141546837), artifact `11703565016`, with its source and build-input identities verified.

The [raw First Map receipt](basemap-first-map-5d64.json) and
[consumer lock](basemap-first-map-5d64.consumer-lock.json) preserve the failed
packed-development measurement. They do not certify a published release.
All 121 non-SDK dependency identities were held fixed, including MapLibre
6.13.0 and its integrity; runtime module paths resolve inside the isolated consumer.

| Measurement | Actual bytes | Ceiling bytes | Excess bytes |
| --- | ---: | ---: | ---: |
| First Map emitted JavaScript | 2,006,698 | 1,990,000 | 16,698 |
| First Map emitted JavaScript gzip | 532,320 | 524,000 | 8,320 |
| Runtime entrypoint gzip | 184,705 | 184,699 | 6 |

The canonical bundle report is regenerated in `docs/bundle-sizes.md` and
retains this measured source revision. CPU and final four-sample live
qualification remain pending a build that passes the unchanged byte ceilings.
