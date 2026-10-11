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

- `2026-10-11-final-ci-installed-quickstart-budget.json` and matching
  `.consumer-lock.json`: source `7c6a67b57`, GitHub run `38137168675`, artifact
  `11702062323`. Live bundle: 1,870,600 raw / 497,269 gzip bytes. Closed-fixture
  CPU medians: 82.624 ms script / 45.524 ms parse-compile, passing the declared
  Ubuntu 24 x64 / Chromium 145 / cold 4x profile. The runner CPU model is recorded
  rather than required. Fixture execution and live bundle measurements stay separate.
- `2026-10-11-final-runtime-tarball.json`: the same clean source and admitted
  producer artifact `11701912054`, after canonical browser/inventory preparation;
  4,071,732 compressed / 19,627,609 unpacked bytes, passing both reduced ceilings.

Final receipts retain their original `sourceSha` and `sourceDirty: false`; later
report commits do not become their measurement source. The local installed
comparison independently matches the hosted live byte totals with all 121
non-SDK dependency version/integrity identities fixed to the prior consumer lock.
Moving the consumer outside the repository removes undeclared optional-peer
resolution; that correction is not claimed as an SDK graph optimization. The
focused PROJJSON validator reduction remains the measured source improvement.
