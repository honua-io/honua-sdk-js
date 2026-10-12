---
type: reference
title: "First Map release-tag provenance qualification"
description: "SDK 0.1.18 three-engine release smoke, including the retained WebKit failure and configured retry."
---
# First Map release-tag provenance qualification

The canonical [SDK 0.1.18 First Map Release Smoke run](https://github.com/honua-io/honua-sdk-js/actions/runs/38319843060)
passed on the immutable `js-sdk-v0.1.18` tag at
`7768fa900a9d02c2045d15a116cfcb8fab6fdd95`. The release-seal check,
three-engine outcome gate, source/packed parity, copyability, and both source
and packed sample verification passed. This completes the release-tag criterion
of [issue 1993](https://github.com/honua-io/honua-sdk-js/issues/1993).

This is a pass under the existing one-retry CI policy, **not a zero-retry pass**.
The unmodified Playwright report records two expected tests, one flaky test,
zero unexpected tests, and zero skips. The canonical sealed matrix receipt
records all three engines passed. Both records are retained together.

| Engine | First attempt | Configured retry | Final result |
| --- | --- | --- | --- |
| Chromium | Passed, 5,839 ms | None | Passed |
| Firefox, headed under Xvfb | Passed, 8,605 ms | None | Passed |
| WebKit | Failed, 5,997 ms | Passed, 8,370 ms | Passed with retry |

WebKit's first attempt failed with `No unobscured rendered First Map feature was
available for the click regression.` The retry ran the same assertions and
passed. Its sealed matrix duration of 14,367 ms includes both attempts; these
are whole-test durations, not the application's first-map latency measurement.
The 10,000 ms first-map and 100 ms interaction assertions remain in the executed
specification, along with fixture isolation, the exact published-prefix result
provenance, real rendered-feature selection, and popup anchoring.

## Source and historical boundaries

[PR 1989](https://github.com/honua-io/honua-sdk-js/pull/1989), merged as
`c1b66b3fd84fbb72f02138069921a44ad953046d`, is an ancestor of the tested tag.
The tagged fixture fetches the rewritten fixture URL and fulfills the original
navigation, preserving `/sdk/maplibre-quickstart/app/` in the document URL. Its
exact provenance assertion remains enforced. Existing focused endpoint tests
cover prefixed directory, index document, and origin-root resolution.

The earlier [SDK 0.1.17 release run](https://github.com/honua-io/honua-sdk-js/actions/runs/38216865401)
failed WebKit on both attempts. Its original receipt and report remain in
`sdk-017/`; the new pass does not overwrite that failure.

[PR 2077](https://github.com/honua-io/honua-sdk-js/pull/2077) separately waits for
the same unobscured rendered-feature predicate within the existing expectation
timeout. It passed an actual hosted WebKit run and merged into current trunk as
`10a3bb69a9f552b90cb70cc0db9dd4234dc8b631`. It is **absent from SDK 0.1.18**;
this release-tag outcome is not evidence that the newer readiness change ran.
No assertion, retry policy, timing budget, or tagged source was changed for the
SDK 0.1.18 observation. This evidence does not claim public npm installation
qualification or a general explanation of WebKit scheduling.

## Retained artifacts

`index.json` binds the source, run, GitHub artifact archive, and byte-for-byte
retained report/receipt hashes. The SDK 0.1.18 matrix artifact is
`11779056003`, named `honua-sdk-first-map-release-matrix`; its ZIP SHA-256 is
`2a6ac0f21c4d41b05f05972e1c4ebac8186fe3bbfe348d8d7e299167e9f1aca5`.
The immutable raw report includes the failed first attempt and successful
retry. The receipt's seven-day freshness window is preserved: this directory
archives the dated observation and does not extend its validity for other
qualification gates.
