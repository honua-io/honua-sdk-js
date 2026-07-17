# Standalone quickstart moved to First Map

The standalone public-service workflow is now the anonymous URL mode of the
canonical [First Map example](../maplibre-quickstart/README.md). Its independent
application, fixtures, and browser suite were removed so the repository has one
tested `connect → discover → explain → query → mount` implementation.

Existing commands remain compatibility redirects:

```bash
npm run demo:standalone       # redirects to demo:quickstart
npm run demo:standalone:mock  # redirects to demo:quickstart:mock
```

Use `VITE_HONUA_QUICKSTART_ENDPOINT` or paste an anonymous GeoServices layer or
OGC API Features URL into First Map. The historical hosted guide route remains
at [`docs/standalone-quickstart.md`](../../docs/standalone-quickstart.md) and
points to the canonical journey.

This directory intentionally contains documentation only. Do not add a second
standalone implementation here.
