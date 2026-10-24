---
type: guide
title: "FOSS4G NA evidence renewal runbook"
description: "How to keep the seven-day golden-journey evidence that samples.honua.io consumes current through FOSS4G NA (Nov 2–4, 2026)."
---
# FOSS4G NA evidence renewal runbook

samples.honua.io (`honua-io/honua-samples`) consumes this repository's
[`samples/dist/honua-site-consumer-handoff.v2.json`](../../../samples/dist/honua-site-consumer-handoff.v2.json)
at a pinned trunk commit. Its daily `producer evidence horizon` check goes red when the earliest
`qualifiedJourneys[].visualEvidence.expiresAt` on that pin is less than **3 days** away. After the
evidence actually expires, gallery admission refuses the handoff. This runbook keeps the four qualified
journeys (`first-map`, `service-explorer`, `imagery-terrain`, `arcgis-migration`) current through the
conference. Tracked in [issue 2217](https://github.com/honua-io/honua-sdk-js/issues/2217).

## Why it does not renew itself on a quiet trunk

- **The window is fixed by policy.** Golden visual evidence, gate receipts, and the First Map
  release-matrix receipt all expire **seven days** after `observedAt`. This is enforced in
  `scripts/sample-gate-receipt.mjs`, `scripts/sample-contract.mjs` and
  `scripts/lib/release-matrix-receipt.mjs`. Do not extend it, and do not edit evidence or `samples/dist/*` by hand.
- **Reseals run in one place.** `regenerate-derived-artifacts.yml` runs every six hours, and it is the only
  path that reseals evidence. Its loop guard skips the run when trunk's tip is already a clean regeneration
  merge. On a quiet trunk every scheduled run is therefore a no-op, and the evidence ages out. A plain
  `gh workflow run regenerate-derived-artifacts.yml` is skipped by the same guard.
- **The release-matrix receipt needs its own run.** `samples/evidence/maplibre-quickstart/release-matrix.v1.json`
  is renewed only by `first-map-release-smoke.yml`. When it lapses, the post-regeneration strict
  validation fails. The regeneration PR then cannot auto-merge, so the journey evidence stops renewing too.

## The renewal command

Dispatch the First Map release smoke on trunk:

```sh
gh workflow run first-map-release-smoke.yml -R honua-io/honua-sdk-js --ref trunk
```

That one dispatch does two things:

1. It reseals the release-matrix receipt through a three-engine run of about 20 minutes.
2. When that finishes, it dispatches `regenerate-derived-artifacts.yml` with `release_matrix_receipt_run_id`. That input
   bypasses the loop guard. The regeneration re-observes all four golden lanes and opens an
   `automation/derived-artifacts-*` PR, which auto-merges once strict validation passes. The whole chain
   takes about 1.5–2 hours.

If trunk's tip is a feature merge rather than a regeneration merge, `Verify release seal` fails fast in the smoke.
That is harmless: the next scheduled regeneration (or
`gh workflow run regenerate-derived-artifacts.yml -R honua-io/honua-sdk-js --ref trunk`) reseals the
tree. Dispatch the smoke again after that merge lands, so the release-matrix receipt is renewed as well.

Do not merge other sdk-js PRs while the chain is running. A trunk move during the publish step makes the
regeneration refuse with `Regeneration source is no longer current trunk`, and the receipt is not persisted.
That is what happened to the 0.2.9 receipt on 2026-10-22, and again on 2026-10-24 when a docs PR
merged mid-chain. If you see that message there are two ways to recover:

- **Re-dispatch the regeneration with the same receipt.** Use this when the commits that landed in between
  touch none of the evidence-neutral digest roots (`EVIDENCE_NEUTRAL_INCLUDED_ROOTS` in
  `scripts/sample-gate-receipt.mjs`: `examples`, `src`, `samples`, `test`, `scripts`, `config`,
  `package.json`, …). A docs-only or README-only merge qualifies. The smoke's sealed artifact is kept for
  90 days:

  ```sh
  gh workflow run regenerate-derived-artifacts.yml -R honua-io/honua-sdk-js --ref trunk \
    -f release_matrix_receipt_run_id=<first-map-release-smoke run id>
  ```

- **Otherwise,** let the scheduled regeneration reseal the new trunk first, then dispatch the smoke again.

## Confirm the renewal

```sh
gh run list -R honua-io/honua-sdk-js -w regenerate-derived-artifacts.yml -L 3
gh api -H "Accept: application/vnd.github.raw" \
  "repos/honua-io/honua-sdk-js/contents/samples/dist/honua-site-consumer-handoff.v2.json?ref=trunk" \
  | jq -r '.qualifiedJourneys[] | "\(.journeyId) \(.visualEvidence.expiresAt)"'
gh api -H "Accept: application/vnd.github.raw" \
  "repos/honua-io/honua-sdk-js/contents/samples/evidence/maplibre-quickstart/release-matrix.v1.json?ref=trunk" \
  | jq -r '"\(.status) \(.expiresAt)"'
```

Every `expiresAt` should be about seven days after the regeneration merge. Then re-pin honua-samples to the new
regeneration **merge commit**, following that repository's producer re-pin procedure in
`scripts/lib/sdk-producer-lock.mjs` (honua-samples PR 74). A renewal in this repository does nothing for
the gallery until that re-pin lands.

## Conference schedule (UTC)

A renewal on day D gives evidence valid until about D+7. The honua-samples horizon trips at about D+4.

| Renew on | Evidence valid until | samples horizon red from | Purpose |
|---|---|---|---|
| Oct 27–28, after pending sdk-js fixes merge | Nov 3–4 | Oct 31–Nov 1 | Re-pin that carries the product fixes |
| **Oct 31** | **Nov 7** | Nov 4 | Covers the conference (Nov 2–4) and the Nov 6 requirement |
| **Nov 3** | **Nov 10** | Nov 7 | Keeps the gallery deployable through and after the conference |

Each row is: dispatch the smoke, confirm the renewal, then re-pin honua-samples. If one dispatch is
missed, the next row still recovers, provided the evidence has not yet expired at the honua-samples pin.

## Observed run, 2026-10-24

| Step | Result |
|---|---|
| [First Map release smoke 40075118715](https://github.com/honua-io/honua-sdk-js/actions/runs/40075118715) on trunk `50e3af0` | Passed. The receipt was sealed with `passed`, and regeneration was dispatched |
| [Regeneration 40075395551](https://github.com/honua-io/honua-sdk-js/actions/runs/40075395551) | Refused with `Regeneration source is no longer current trunk`, because #2214 (docs only) merged mid-chain |
| [Regeneration 40076599928](https://github.com/honua-io/honua-sdk-js/actions/runs/40076599928) with `release_matrix_receipt_run_id=40075118715` | Passed. [#2219](https://github.com/honua-io/honua-sdk-js/pull/2219) auto-merged as `ae194c7` |

At `ae194c7`, the four qualified journeys expire at 2026-10-31T08:12–08:14Z. The release-matrix receipt
expires at 2026-10-31T07:43Z, and the catalog live-evidence entries for the golden samples expire on 2026-11-24.
Before the renewal, the honua-samples pin (`a161ea0`) expired at 2026-10-29T21:58Z and the release-matrix
receipt at 2026-10-28T08:27Z.
