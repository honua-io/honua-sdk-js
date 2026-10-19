fix(docs): fail the registry freshness guard on unrecorded stable releases

The trunk/docs-release registry guard (`scripts/check-docs-release.mjs registry`, added in #1613) only compared npm *prerelease* versions against the documentation manifest's `latestRelease`. The SDK now ships stable `0.2.x` releases, so a stable publish the manifest has not recorded (e.g. npm `0.2.5` while `versions.json` says `0.2.4`) passed the guard silently. That is the same lag that turned every honua-site PR red when `0.1.9-beta.0` shipped: honua-site snapshots `https://honua-io.github.io/honua-sdk-js/versions.json` and validates its published-version claims against it.

## Change
- `assertRegistryFreshness` now fails when **any** npm version of `@honua/sdk-js` / `@honua/sdk-esri-compat` (stable or prerelease) is newer than the manifest's `latestRelease`.
- New regression test `registry guard catches a stable release the manifest has not recorded`; it fails against the old filter.

## State at time of writing (2026-10-19)
- The original 0.1.9-beta.0 lag was already fixed by #1613; the publish gate (`publish-js-sdk.yml`, `check-docs-release.mjs publish`) runs before npm publish.
- Hosted `versions.json` declares `latestRelease` 0.2.4, matching npm `latest` for both packages (`node scripts/check-docs-release.mjs hosted` passes).

## Verification
```
node --test test/scripts/docs-versions.test.mjs test/scripts/check-docs-release.test.mjs   # 16/16 pass
node scripts/check-docs-release.mjs registry   # docs release registry: latestRelease 0.2.4
node scripts/check-docs-release.mjs hosted     # docs release hosted: latestRelease 0.2.4 at https://honua-io.github.io/honua-sdk-js/versions.json
```
Reverting only the script change makes the new test fail (proved locally).
