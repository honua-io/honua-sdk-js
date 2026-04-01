# Honua 2.5D Demo Fixtures

Deterministic fixture payloads for the `examples/storytelling-25d-map/` demo.

These files intentionally mirror the runtime shapes used by the demo app:

- `capabilities.json`: `GET /api/v1/admin/capabilities`
- `assets.json`: `GET /ogc/features/collections/story-25d-assets/items`
- `route.json`: `GET /ogc/features/collections/story-25d-route/items`
- `stops.json`: `GET /ogc/features/collections/story-25d-stops/items`

Canonical fixture properties:

- `capabilities.json` reports a supported `1.0.0` / `stable` compatibility contract on `/api/v1/admin`
- `assets.json` uses stable feature ids plus canonical `risk_score`, `extrusion_height_m`, and optional `linked_stop_id`
- `route.json` uses a single `LineString` feature for playback
- `stops.json` uses canonical `sequence` and `linked_asset_id` properties

Mock-lane behavior:

- `examples/storytelling-25d-map/mock-server.mjs` builds the demo with `VITE_HONUA_25D_BASE_URL=""` so every SDK
  request stays same-origin against the fixture server
- the mock lane also overrides `VITE_HONUA_25D_BASEMAP_STYLE` to `/__honua-25d__/basemap-style.json`
- the fixture server only serves the initial compatibility response and first-page OGC `items?limit=250` payloads;
  story-step transitions and route replay stay client-side after load

The fixture lane exists for local review and browser smoke coverage. The live runtime path still uses the same
SDK-supported Honua compatibility endpoint and OGC API Features collections, but the example README documents the
additional alias support accepted by live payload normalization.
