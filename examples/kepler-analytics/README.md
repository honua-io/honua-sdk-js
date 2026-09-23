# Kepler analytics demo (retired)

This demo was retired in September 2026. Its source, dependencies and lockfile
are gone; this page remains because honua-site's frozen consumer archive
(`samples/contract/v2/consumer-fixtures/honua-site-consumer-handoff.legacy.v1.json`)
records a card pointing here, and an archive stops being an archive if it is
rewritten.

## Why

[GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579) is a
critical XSS sanitizer bypass in MapLibre GL JS covering **every release at or
below 6.4.0**, patched in 6.4.1 with no backport to 3.x, 4.x or 5.x.
`@kepler.gl/components@3.2.6` depends on `maplibre-gl ^3.6.2`, and the only
newer kepler.gl release is a prerelease, so this demo could not be brought to a
safe version.

Forcing `maplibre-gl ^6.4.1` was tried and does clear the audit completely — but
the demo then fails to build, because MapLibre 6 is ESM-only and kepler.gl
resolves it through a `require` condition. A green audit over a demo that no
longer builds is worse than a red one.

Removing it also ends a recurring drift gate that had failed twice on upstream
advisories this repository cannot act on (fflate in #1621, MapLibre here).

## What this does not affect

The **Kepler workspace bridge** is an SDK feature and is untouched:
`@honua/sdk-js/kepler`, `src/kepler/`, and
[kepler-workspace-bridge.md](../../docs/kepler-workspace-bridge.md). It converts
Honua sources into kepler.gl workspace configuration and carries no MapLibre
dependency of its own — the host application supplies the renderer, and should
supply 6.4.1 or newer.

## If you want this demo back

It returns when kepler.gl ships a release depending on `maplibre-gl >= 6.4.1`.
The retired source is in this repository's history.
