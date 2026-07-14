# Sample publication contract v1

> Compatibility only: v1 is frozen for existing consumers. The canonical
> catalog, taxonomy, lifecycle policy, CI selection, and site projection are
> defined by [`../v2/README.md`](../v2/README.md). New consumers must use v2.

This directory is the versioned handoff between `honua-sdk-js` and presentation consumers such as `honua-site`.

- `sample-catalog.schema.json` describes SDK-owned executable sources and the explicit mapping of the 21 pre-contract honua.io routes.
- `site-projection.schema.json` contains only static-presentation-safe metadata. It deliberately omits configuration values, commands, credentials, and executable source copies.
- `browser-artifacts.schema.json` binds a package version and Git SHA to build inputs, peers, entrypoints, bytes, SHA-256 digests, and Subresource Integrity values.
- `sample-evidence.schema.json` is shared by fixture and live lanes. A non-executed lane records `failed`, `skipped`, or `credential-unavailable` plus a reason rather than pretending it ran.
- A catalog live lane may publish `evidencePath`; validation requires that the versioned envelope exists and that its sample, lane, and status match before the site projection exports the path.
- `consumer-fixtures/honua-site-consumer.v1.json` pins the accepted producer versions, projection digest, route assertions, and representative SDK-owned/exception routes that site CI can use before artifact publication is wired into deployment.

The canonical catalog deliberately stores the SDK package name but not a
version. Generation derives the effective version from root `package.json` and
materializes it into the site projection. Version-only projection and digest
changes are accepted during release-please bumps, while semantic or independent
integrity drift still fails. The publish workflow regenerates the projection
before packing, so the npm artifact always carries its exact release version.

Schema evolution is additive within v1. Removing or changing a required field requires a new format/schema version and a coordinated consumer migration. Required pull-request validation is offline. Live evidence is produced only by scheduled, manual, or deployment-gated workflows and must never contain credentials or feature payloads.

Run `npm run samples:verify` to validate repository inventory and generated projections. Run `npm run samples:artifacts` to build the browser files and write their verified publication manifest to `dist/browser/honua-sdk.browser-artifacts.v1.json` for inclusion in the root npm package.
