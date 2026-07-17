# Standalone quickstart moved to First Map

The server-optional public-endpoint workflow is now the canonical
[First Map quickstart](./quickstart.md). It accepts anonymous GeoServices FeatureServer layers and OGC API Features
endpoints, then shows the discovered source, accepted query plan, bounded result, MapLibre map, popup, filter,
attribution, observation/freshness, cache status, degradation, and cleanup evidence.

There is one runnable implementation:

```bash
npm run demo:quickstart:mock
```

The historical commands remain compatibility aliases and execute that same app:

```bash
npm run demo:standalone
npm run demo:standalone:mock
```

The [`examples/standalone-quickstart`](../examples/standalone-quickstart/README.md) directory is documentation-only.
It must not regain source, fixture, Vite, or Playwright implementations. Existing links can remain stable while new
guides and sample catalog entries point directly to
[`examples/maplibre-quickstart`](../examples/maplibre-quickstart/README.md).

For the lower-level caller-owned-map API, see the focused
[`mountSource` data-to-map bridge recipe](./data-to-map-bridge.md). For a framework-specific integration, keep using
the focused [React quickstart](../examples/react-quickstart/README.md); it is not a second First Map implementation.
