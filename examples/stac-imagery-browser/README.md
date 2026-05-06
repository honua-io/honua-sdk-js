# Honua STAC Imagery Catalog Browser

Fixture-backed sample app for discovering imagery through a Honua Cloud-oriented STAC workflow.

The sample demonstrates:

- AOI, time, collection, cloud cover, and asset type filters.
- Collection metadata cache state and schema cache visibility.
- Incremental pagination with an explicit cancel state.
- Footprint preview and item metadata inspection.
- Supported renderable tile or thumbnail preview projection.
- Clear unsupported messaging for raster analysis and coverage export.

The default app uses deterministic fixtures and performs no external network calls. A live Honua Cloud-backed catalog can reuse the same model shape once credentials and STAC service wiring are supplied by the host application.

## Commands

```sh
npm run demo:stac-browser
npm run demo:stac-browser:build
npm run demo:stac-browser:typecheck
npm run test:playwright:stac-browser
```
