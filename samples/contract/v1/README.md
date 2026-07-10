# Sample publication contract v1

This directory is the versioned handoff between `honua-sdk-js` and presentation consumers such as `honua-site`.

- `sample-catalog.schema.json` describes SDK-owned executable sources and the explicit mapping of the 21 pre-contract honua.io routes.
- `site-projection.schema.json` contains only static-presentation-safe metadata. It deliberately omits configuration values, commands, credentials, and executable source copies.
- `browser-artifacts.schema.json` binds a package version and Git SHA to build inputs, peers, entrypoints, bytes, SHA-256 digests, and Subresource Integrity values.
- `sample-evidence.schema.json` is shared by fixture and live lanes. A non-executed lane records `failed`, `skipped`, or `credential-unavailable` plus a reason rather than pretending it ran.
- `consumer-fixtures/honua-site-consumer.v1.json` pins the accepted producer versions, projection digest, route assertions, and representative SDK-owned/exception routes that site CI can use before artifact publication is wired into deployment.

Schema evolution is additive within v1. Removing or changing a required field requires a new format/schema version and a coordinated consumer migration. Required pull-request validation is offline. Live evidence is produced only by scheduled, manual, or deployment-gated workflows and must never contain credentials or feature payloads.

Run `npm run samples:verify` to validate repository inventory and generated projections. Run `npm run samples:artifacts` to build the browser files and write their verified publication manifest to `dist/browser/honua-sdk.browser-artifacts.v1.json` for inclusion in the root npm package.
