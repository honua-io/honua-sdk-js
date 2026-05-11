# Control-Plane Contract Fixtures

These fixtures document the first experimental `/api/v1/admin` SDK contract slice for hosted maps, map packages, imports/jobs, and API tokens.

- `hosted-map-list.v1.json` covers cursor pagination plus `ETag`/`Last-Modified` validators.
- `map-package-publish.v1.json` covers optimistic concurrency via `If-Match` and long-running publish job handoff.
- `api-token-create.v1.json` covers token creation without durable secret echo. The reveal value is a redacted fixture sentinel.
- `unsupported-capability.v1.json` covers typed degraded responses when a deployment omits a control-plane capability.

Secret-bearing fields must remain redacted in fixtures, snapshots, logs, and problem payloads.
