---
type: index
---

# Distribution measurements

Receipts and consumer locks are preserved as recorded; temporary archive URLs
and receipt output paths are historical identifiers rather than files to open.

- `2026-10-11-oxc*` and `2026-10-11-terser*`: source `5aac8654`, identical
  installed package/dependency identities, measured minifier experiment. The
  canonical minifier remains Oxc because Terser increased gzip and build time.
- `2026-10-11-runtime-tarball.json`: packed ownership/size audit at that source.
- `2026-10-11-entrypoint-comparison.json`: preserved producer artifacts at
  `5aac8654` and `8b5b0a05`, identical canonical esbuild options. The focused
  PROJJSON graph improves; the generic hero graph is unchanged.
- `2026-10-11-ci-installed-quickstart-budget.json` and matching
  `.consumer-lock.json`: exact-head `8b5b0a05` CI calibration, run `38130548203`,
  artifact `11698283813`.
- `2026-10-11-ci-merge-installed-quickstart-budget.json` and matching
  `.consumer-lock.json`: separate GitHub test-merge `b304bef7` calibration,
  run `38130548207`, artifact `11698779861`.

The execution configuration uses the exact-head calibration, with the separate
merge run showing variation across provisioned runner CPUs. These receipts are
packed development evidence, not published registry or live candidate certification.
