# Honua 2.5D Storytelling Demo

Portfolio-grade browser demo for a pitched `2.5D` corridor walkthrough.

What it shows:

- Honua compatibility gating through `HonuaClient.checkCompatibility()`
- OGC API Features collections loaded through `client.ogcFeatures().collection(...).items()`
- polygon extrusions on a pitched MapLibre map
- deterministic story steps with camera transitions and an animated route replay

What it does **not** claim:

- full `3D`
- terrain or mesh rendering
- digital-twin parity

## Fast Local Run

This repo ships a deterministic local review lane that mirrors the live browser calls with fixture-backed Honua
endpoint shapes.

```bash
npm install
npm run demo:25d:mock
```

The script:

1. builds the example app
2. serves the built app locally
3. serves fixture responses for `GET /api/v1/admin/capabilities`
4. serves fixture OGC collections for assets, route, and stops

The local URL is printed as `story25dMockUrl=http://127.0.0.1:PORT`.

## Live Honua Run

Point the same app at a prepared Honua environment with the documented collection names:

```bash
cp examples/storytelling-25d-map/.env.example examples/storytelling-25d-map/.env
npm run demo:25d
```

Required live data contract:

- assets collection: polygon features with stable ids plus numeric `risk_score` and `extrusion_height_m`
- route collection: at least one line feature
- stops collection: point features with a deterministic `sequence`

Default collection ids:

- `story-25d-assets`
- `story-25d-route`
- `story-25d-stops`

Override them in `examples/storytelling-25d-map/.env` if your environment uses different ids.

## Story Steps

The walkthrough is fixed to four named steps:

1. `Overview`
2. `Triage`
3. `Route Replay`
4. `Asset Focus`

The route replay is client-side after the initial load, so the animation does not re-fetch data while it runs.

## Fixtures

Deterministic payloads used by the local mock lane and browser smoke coverage live in
`test/fixtures/honua-25d-demo/`.

## Follow-on Child Ticket

Bounded external follow-on, intentionally not implemented in this repo:

- `honua-server`: add a deterministic `25d-demo` seed/profile that publishes the same polygon, route, and stop
  collections with stable ids and numeric risk/height attributes.
