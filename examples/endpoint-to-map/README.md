# Endpoint to Map moved to First Map

The runnable endpoint-to-map application has been consolidated into the
canonical [First Map example](../maplibre-quickstart/README.md). First Map keeps
the direct endpoint workflow inspectable while adding source discovery, an
accepted plan, bounded execution, MapLibre mounting, popup/filter interaction,
and evidence.

Existing commands remain compatibility redirects:

```bash
npm run demo:endpoint-to-map       # redirects to demo:quickstart
npm run demo:endpoint-to-map:mock  # redirects to demo:quickstart:mock
```

The lower-level `connect()` + `mountSource()` API remains documented as a
focused recipe in [`docs/data-to-map-bridge.md`](../../docs/data-to-map-bridge.md).
That recipe is not a second application or a fallback implementation.

This directory intentionally contains documentation only. Do not restore the
retired application shell.
