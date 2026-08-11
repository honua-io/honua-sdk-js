# Publish a Honua layer as PMTiles

This server-side walkthrough submits a durable Honua `publish` job, reports
bounded progress, and converts the completed artifact into renderer-neutral and
MapLibre source descriptors. The admin credential never enters a browser bundle.

Managed publication is **experimental and contract-only** in the SDK evidence
matrix. The client fixture proves the versioned Honua Server contract, but no
pinned public deployment canary currently proves an end-to-end managed publish.

## Run against your deployment

Configure the variables from [`.env.example`](./.env.example), then run:

```bash
npm run demo:pmtiles-managed
```

Expected terminal output ends with a receipt shaped like:

```json
{"status":"ready","delivery":"honua-range-proxy","archiveUrl":"https://honua.example/api/v1/tiles/pmtiles/ARTIFACT_ID","maplibreUrl":"pmtiles://https://honua.example/api/v1/tiles/pmtiles/ARTIFACT_ID","cleanup":{"mode":"republish-overwrite","manualDeleteSupported":false}}
```

Pressing Ctrl+C requests server cancellation. Client disposal only releases
listeners; it never pretends to delete a server-owned artifact. Temporary
archives expire under the server retention policy, while durable publish keys
are replaced atomically by a later publish of the same layer/matrix.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| `401` or `403` | Use a server-side admin token/API key with tile-operation permission. |
| `400` on submit | Verify the layer, zoom order, bbox, tile matrix, and `maxTiles` ceiling. |
| Job fails during upload | Configure Honua cloud file storage; inspect the typed job error and warnings. |
| Signed source is expired | Publish again to rotate the URL; the SDK refuses an expired descriptor. |
| Browser range request fails | Expose `Content-Range`, `Content-Length`, `Accept-Ranges`, ETag, and last-modified headers. |

Complete Walkthrough: [docs/examples/pmtiles-managed-lifecycle](https://github.com/honua-io/honua-sdk-js/tree/trunk/docs/examples/pmtiles-managed-lifecycle)

API details: [PMTiles lifecycle guide](../../docs/pmtiles-lifecycle.md).
