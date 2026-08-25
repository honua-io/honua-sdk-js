---
name: honua-publish-layers
description: Use when turning an imported table into a served Honua layer and setting who can read it — publishing a layer from a tested connection, capturing the layer id, setting the service access policy, and confirming the layer is queryable. Covers the publication half of 2026.1 zero-to-map stage 2 (admin).
release: "2026.1"
stages: [admin]
---

# Import and service/layer publication (stage 2: `admin`)

Second half of stage `admin` in `mcp/release/zero-to-map/journey.v1.json`.
Precondition: a connection that has been created *and tested*, and an import
job that reached a terminal success state — see `honua-datasource-connect`.

## Publish the layer

```
honua_admin_layer_publish
{
  "id": "<connectionId>",
  "body": {
    "schema": "public",
    "table": "zero_to_map_parcels",
    "layerName": "Parcels",
    "serviceName": "zero-to-map",
    "geometryColumn": "geometry",
    "geometryType": "Polygon",
    "srid": 4326,
    "primaryKey": "parcel_id",
    "enabled": true
  }
}
```

Capture `/data/layerId` from the response. That id, plus `serviceName`, is how
every downstream stage addresses the layer — Studio binds it as
`honua://services/<serviceName>/layers/<layerId>`.

Notes that prevent the common failures:

- `geometryType`, `srid`, `geometryColumn`, and `primaryKey` must match the
  table as imported. If publish fails, run `validateConnectionTableForPublish`
  (`POST /connections/{id}/tables/validate`) rather than permuting values.
- One `serviceName` groups multiple layers. Publish each layer separately
  against the same `serviceName` when they belong to the same service.
- `enabled: false` publishes without serving. `setLayerEnabled`
  (`PUT /connections/{id}/layers/{layerId}/enabled`) flips it later.
- `getPublishedLayers` (`GET /connections/{id}/layers`) is the inventory call.

The underlying admin REST operation is `publishLayer`
(`POST /connections/{id}/layers`); the full `publish` group is in
`docs/admin-cli-reference.md`.

## Set access explicitly

Publication does not decide visibility. The journey sets it as a separate,
auditable step:

```
honua_admin_service_set_access_policy
{
  "serviceName": "zero-to-map",
  "body": { "allowAnonymous": true, "allowAnonymousWrite": false }
}
```

- `allowAnonymous: true` makes the service world-readable. This is a security
  decision — never take it on the agent's own initiative. Ask, and record that
  the human asked for it.
- `allowAnonymousWrite` stays `false`. Honua has no AI operational-data-editing
  path (honua-server ADR-0028); an agent that wants anonymous write is doing
  something wrong.

## Confirm the layer is really queryable

Publication succeeding is not proof the layer serves data. Verify through the
read-only tools before moving to geoprocessing or composition:

- `honua_list_sources` — the new layer should appear as a
  `<protocol>:<address>` reference.
- `honua_describe_layer` — fields, geometry type, extent, and the capabilities
  the source *actually* supports.
- `honua_count_features` — a non-zero count proves rows landed.
- `honua_get_extent` — a sane bounding box proves the SRID is right. A world-
  spanning or null-island extent almost always means `sourceSrid`/`targetSrid`
  were wrong at import time, not at publish time.

## Layer metadata and styling knobs

Once served, these admin operations shape how the layer presents (see the
`publish` group in `docs/admin-cli-reference.md`):

- `getAdminLayerFields` / `updateAdminLayerFields` — field visibility, aliases.
- `getAdminLayerStyle` / `updateAdminLayerStyle`, `suggestLayerStyle` —
  server-side style.
- `setAdminLayerPopupInfo`, `setAdminLayerDrawingInfo`, `updateAdminLayerFilter`
  — popups, drawing info, and a permanent layer filter.
- `getAdminLayerValidation` — validates layer metadata; run it before you claim
  a layer is ready.

For verifying the *rendered* result, use the `honua-style-verify` skill.

## Verify

- `docs/admin-cli-reference.md` — the `publish` operation table.
- `mcp/release/zero-to-map/journey.v1.json` — stage `admin`.
- `docs/zero-to-map-release-journey.md` — what stage 2 must prove.
