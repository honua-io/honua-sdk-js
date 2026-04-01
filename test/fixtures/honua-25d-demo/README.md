# Honua 2.5D Demo Fixtures

Deterministic fixture payloads for the `examples/storytelling-25d-map/` demo.

These files intentionally mirror the runtime shapes used by the demo app:

- `capabilities.json`: `GET /api/v1/admin/capabilities`
- `assets.json`: `GET /ogc/features/collections/story-25d-assets/items`
- `route.json`: `GET /ogc/features/collections/story-25d-route/items`
- `stops.json`: `GET /ogc/features/collections/story-25d-stops/items`

The fixture lane exists for local review and browser smoke coverage. The live runtime path still uses the same
SDK-supported Honua compatibility endpoint and OGC API Features collections.
