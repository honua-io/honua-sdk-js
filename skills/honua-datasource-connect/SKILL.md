---
name: honua-datasource-connect
description: Use when connecting Honua to a datasource and proving the connection works before publishing anything — creating a secure connection by secret reference, testing it, listing and validating tables, and discovering already-reachable sources on a plain endpoint. Covers the connection half of 2026.1 zero-to-map stage 2 (admin).
release: "2026.1"
stages: [admin]
---

# Datasource connection and validation (stage 2: `admin`)

First half of stage `admin` in `mcp/release/zero-to-map/journey.v1.json`:
create a connection, test it, and validate a table *before* any import or
publish. Publishing is the `honua-publish-layers` skill.

## Create the connection by reference, never by value

`honua_admin_connection_create` takes a body whose credential is a
**reference**, not a password:

```json
{
  "name": "zero-to-map",
  "host": "postgis",
  "port": 5432,
  "databaseName": "honua",
  "username": "honua",
  "secretReference": "env:HONUA_ZERO_TO_MAP_DB_CONNECTION",
  "secretType": "environment",
  "sslRequired": false,
  "sslMode": "Disable"
}
```

Rules:

- `secretType: "environment"` + `secretReference: "env:<VAR>"` is the supported
  handoff. Never inline a password, connection string, or token in the body,
  in a plan, or in a message back to the user.
- `sslRequired: false` / `sslMode: "Disable"` is correct **only** for a loopback
  fixture database like the journey's. For anything reachable off the host,
  require TLS.
- Capture `/data/connectionId` from the response. Every later call in this stage
  is keyed on it.

The equivalent admin REST operations, if you are driving the CLI instead, are
`createConnection` (`POST /connections`) and `testDraftConnection`
(`POST /connections/test`) — see `docs/admin-cli-reference.md`.

## Test before trusting

```
honua_admin_connection_test  { "id": "<connectionId>" }
```

A saved connection that was never tested is not evidence. Run the test and read
its result; do not infer success from the create call returning an id.

Related admin operations when you need more than pass/fail:

- `getConnectionTables` (`GET /connections/{id}/tables`) — what is actually
  reachable.
- `validateConnectionTableForPublish` (`POST /connections/{id}/tables/validate`)
  — checks a table is publishable (geometry column, SRID, primary key) before
  you attempt `publishLayer`. Run this when a publish fails rather than
  guessing at the geometry type.
- `validateConnectionEncryption` / `rotateConnectionEncryptionKey` — encryption
  service health and key rotation.

## Import fixture or file data into the connection

The journey imports by URL so nothing is uploaded from the agent's machine:

```
honua_admin_import_upload_url
{
  "body": {
    "sourceUrl": "<https url to the file>",
    "fileName": "parcels.geojson",
    "tableName": "zero_to_map_parcels",
    "targetSchema": "public",
    "sourceSrid": 4326,
    "targetSrid": 4326,
    "overwriteExisting": true
  }
}
```

`overwriteExisting: true` is destructive. Only set it when the user has said the
table is disposable, and say so in the plan.

Imports are jobs. Poll `getImportJobStatus` (`GET /import/jobs/{jobId}`) to a
terminal state before publishing; `cancelImportJob` stops one. `getImportLimits`
and `getImportFormats` tell you up front whether the file is even accepted.

## Discovery on a plain endpoint (no Honua admin surface)

If there is no admin API — a public ArcGIS/OGC endpoint — there is nothing to
"connect". Discover instead, using the read-only standalone tools in
`mcp/src/tools/`:

- `honua_list_sources` — protocol-neutral discovery; returns the
  `<protocol>:<address>` reference every other tool accepts. Always call this
  first and pass its `source` values verbatim.
- `honua_describe_layer` — protocol, real capabilities, fields, geometry type,
  extent.
- `honua_count_features` — cardinality before you pull rows.
- `honua_explain_capability_gap` — when a construct is refused, this says
  whether it is a capability gap and what the safe fallback is.

A capability miss returns a structured capability error. Treat it as "this
protocol cannot express that", never as "no features matched".

## Verify

- `docs/admin-cli-reference.md` — the `connect` and `import` operation tables.
- `docs/auth.md` — credential stores and transport wiring.
- `mcp/README.md` — the standalone tool contract and graceful degradation.
- `mcp/release/zero-to-map/journey.v1.json` — stage `admin`.
