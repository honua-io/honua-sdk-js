# Backend-agnostic raw-layout fixtures

Recorded responses from public standards servers, used by the deterministic
`*-backend-agnostic.test.ts` suites so the raw endpoint layouts are covered
without network access. The scheduled `standalone-live-smoke` workflow
re-verifies the same live servers weekly.

| Dir | Source (recorded) | Layout shape proven |
| --- | --- | --- |
| `pygeoapi/` | `https://demo.pygeoapi.io/master` | OGC API Features — landing-link discovery (`rel=data`/`rel=conformance`), `lakes` collection + items |
| `ldproxy/` | `https://demo.ldproxy.net/vineyards` | OGC API Features — ldproxy landing + `vineyards` items |
| `honua-facade/` | synthetic | Honua Server `/ogc/features/...` facade landing (parity reference) |
| `earth-search-stac/` | `https://earth-search.aws.element84.com/v1` | STAC API root — landing (`conformsTo`) + `/search` |
| `stac-static/` | synthetic | Static STAC `catalog.json` → `child` collection → `item` tree |
| `geoserver-wfs/` | `https://ahocevar.com/geoserver` | WFS 2.0 GetCapabilities with DCP operation URLs (`/geoserver/ows` endpoint advertising `/geoserver/wfs`) + GeoJSON GetFeature |
| `odata/` | `https://services.odata.org/TripPinRESTierService` | OData v4 `$metadata` (CSDL) + `People` page against an arbitrary service root |

Payloads are trimmed (few features, shortened geometries) but structurally
faithful to what the live servers return. To refresh, re-fetch the documented
URLs and re-trim; keep the shapes the tests assert on intact.
