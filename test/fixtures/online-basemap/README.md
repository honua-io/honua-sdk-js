# Offline basemap binding fixture v1

These Honua-authored synthetic MapLibre v8 styles contain one inline GeoJSON
point and a background layer. They exercise attribution, theme changes and
operational state preservation with HTTP restricted to the local fixture server.
They are not downloaded OpenFreeMap styles or a geographic data snapshot. No
external tile, glyph, sprite, imagery or geocoding requests are needed.

The `Example contributors` and `Operational fixture contributor` credits are
explicit test labels, used to prove both basemap and operational credits remain
visible at mobile width. Styles/data are fixture version 1, covered by this
repository's Apache-2.0 license. Renderer and SDK sources are pinned by the
repository lockfile and source commit.

| Asset | SHA-256 |
|---|---|
| light.json | f530d58c5299f158b8cf903ff564931e02736ddabd108dcfd30c8e7216ebfc9e |
| dark.json | 02240d82b86e765eb3bfae7b06ce05c0f5772b754f4e40b19c28394f711f8a3b |

The opt-in provider availability test uses normal browser requests at zoom 1 in
a 390×300 viewport, records a dated receipt separately and leaves these fixtures
unchanged. It is not a tile downloader or an offline cache seeding workflow.
