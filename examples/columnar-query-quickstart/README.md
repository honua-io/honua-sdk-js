# Bounded columnar query plan

This atomic example builds and displays a typed `f=arrow` FeatureServer plan without making a network request. It teaches projection, bbox, filter, ordering, row limits, and resource ceilings before decoding or rendering.

It intentionally uses `example.invalid`: no demo-manifest target currently proves live Arrow or Parquet server output. A separate SDK interoperability test decodes an exact Honua Server `geoarrow.wkb` IPC artifact, but that fixture is not a network canary and does not make this planning-only example live.

```bash
npm run demo:columnar-query
```
