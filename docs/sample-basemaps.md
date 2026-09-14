# Basemaps for Honua samples

Use OpenFreeMap for online MapLibre sample basemaps. As checked on 2026-09-14,
the [public service](https://openfreemap.org/) allows commercial use, needs no
account or API key, and states no map-view or request limits. It does not provide
an SLA. This is a sample default; applications can override the style URL or
self-host the open stack when they need operational control.

| Sample purpose | Style URL |
| --- | --- |
| Quiet background for dashboards and thematic overlays | `https://tiles.openfreemap.org/styles/positron` |
| Street detail for finders and editing | `https://tiles.openfreemap.org/styles/liberty` |
| Dark theme | `https://tiles.openfreemap.org/styles/dark` |

The conversion cohort uses these defaults: powerplants uses Positron/Dark;
finder and Editor use Liberty. The helicopter conversion should use Positron.
These are vector street/context maps, not satellite imagery or elevation data.
The rest of the SDK gallery and starter templates still need an explicit rollout.

## Integration rules

- Use the provider's complete style URL so its tiles, glyphs and sprites stay
  coherent. Keep the style URL configurable with the sample's existing override.
- Keep MapLibre's attribution control enabled. The vector source's TileJSON
  supplies OpenMapTiles/OpenStreetMap attribution. Preserve it in screenshots
  and exports too; OpenFreeMap credit is appreciated. See the provider's
  [attribution guidance](https://openfreemap.org/#attribution).
- Keep operational data sources separate from the basemap. Changing a basemap
  must preserve imported layer bindings, filters, selection and access policy.
- Retain fixture styles in deterministic CI, offline demonstrations and tests
  whose subject is a different tile provider. A public basemap must not become
  an implicit network requirement for those lanes.
- Show a useful loading/error state if basemap assets fail, while keeping the
  operational data and controls usable. Do not silently substitute another
  provider or remove attribution.
- Browser caching is normal. For offline packs or a hosted Honua basemap, use
  the provider's documented [downloads/self-hosting workflow](https://openfreemap.org/quick_start/)
  and record the data/style version; do not qualify a mutable public endpoint
  as a reproducible snapshot.

The SDK remains provider-neutral. Samples choose this default explicitly;
constructing a core client must not start basemap requests.
