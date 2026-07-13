# Provider-pluggable geocoding and routing

> Status: **experimental** (`@experimental` JSDoc). Shapes may change in any
> minor release prior to `1.0.0`.

`@honua/sdk-js/geocoding` and `@honua/sdk-js/routing` expose provider-neutral
contracts — `GeocodingProvider` (`geocode` / `reverse` / `suggest`) and
`RoutingProvider` (`route`) — with first-party adapters for open-source
services. No Honua server is required: the Honua facade is just one provider
among several, and the same typed calls work against every adapter.

Three rules apply to every adapter:

1. **Explicit endpoints only.** Every third-party adapter requires a
   `baseUrl`. The SDK never bakes in a default third-party endpoint, so you
   cannot accidentally send production traffic to a community service whose
   usage policy you have not read.
2. **Declared capabilities.** Capability differences are declared on the
   provider and enforced by the SDK's existing capability policy: an
   unsupported operation throws `HonuaCapabilityNotSupportedError` under the
   default `"strict"` policy (or resolves empty under `"degraded"`).
3. **Attribution travels with results.** Every provider exposes
   `attribution` / `usagePolicyUrl`, and every result carries a `provenance`
   object identifying the provider and repeating those obligations, so hosts
   can render attribution wherever results surface.

## Capability matrix

| Provider | geocode | reverse | suggest | route | Notes |
|----------|---------|---------|---------|-------|-------|
| `honua` (facade) | ✓ | ✓ | ✓ | ✓ | Wraps `HonuaGeocodingClient` / the esri-compat route solver |
| `nominatim` | ✓ | ✓ | — (throws typed error) | | No typeahead endpoint; the OSMF policy forbids autocomplete traffic |
| `photon` | ✓ | ✓ | ✓ | | Typeahead-first engine |
| `pelias` | ✓ | ✓ | ✓ (`/v1/autocomplete`) | | Hosted instances usually need an `apiKey` |
| `osrm` | | | | ✓ | OSRM HTTP API v1, GeoJSON geometry |
| `valhalla` | | | | ✓ | 1e-6 encoded polylines, decoded for you |

## Geocoding

### Nominatim (geocode + reverse; no suggest)

```ts
import { nominatimGeocodingProvider } from "@honua/sdk-js/geocoding";

const geocoder = nominatimGeocodingProvider({
  baseUrl: "https://nominatim.example.org",   // your instance
  userAgent: "my-app/1.0 (ops@example.org)",  // REQUIRED by the OSMF policy on the public instance
  email: "ops@example.org",                   // public-instance etiquette
});

const [best] = await geocoder.geocode("530 South King Street, Honolulu", { limit: 1 });
console.log(best.latitude, best.longitude, best.provenance.attribution);

const here = await geocoder.reverse(21.3059, -157.858); // latitude first
```

Capability miss, by declaration rather than by surprise:

```ts
import { HonuaCapabilityNotSupportedError } from "@honua/sdk-js";

try {
  await geocoder.suggest("honol");
} catch (error) {
  if (error instanceof HonuaCapabilityNotSupportedError) {
    // error.capability === "suggest", error.protocol === "nominatim"
  }
}
// Or opt into degraded mode: suggest() resolves to [] instead of throwing.
nominatimGeocodingProvider({ baseUrl, capabilityPolicy: "degraded" });
```

**Usage policy** (public `nominatim.openstreetmap.org`): absolute maximum of
1 request/second, a real `User-Agent` identifying your application, no
autocomplete traffic, and results must credit OpenStreetMap. Read
<https://operations.osmfoundation.org/policies/nominatim/> before pointing at
the public instance; self-host for anything heavier.
**Attribution**: `Data © OpenStreetMap contributors, ODbL 1.0`.

### Photon (geocode + reverse + suggest)

```ts
import { photonGeocodingProvider } from "@honua/sdk-js/geocoding";

const photon = photonGeocodingProvider({ baseUrl: "https://photon.example.org" });
const hints = await photon.suggest("honol", { limit: 5 }); // typeahead-first engine
```

**Usage policy**: the komoot-operated `photon.komoot.io` is fair-use for
moderate volumes (see <https://photon.komoot.io/>); self-host for production.
**Attribution**: OpenStreetMap (ODbL), as above.

### Pelias (geocode + reverse + suggest via autocomplete)

```ts
import { peliasGeocodingProvider } from "@honua/sdk-js/geocoding";

const pelias = peliasGeocodingProvider({
  baseUrl: "https://pelias.example.org",
  apiKey: process.env.PELIAS_API_KEY,          // hosted instances (e.g. geocode.earth)
  attribution: "© OpenStreetMap contributors; © OpenAddresses; Who's On First",
});

const hints = await pelias.suggest("honol");   // dedicated /v1/autocomplete endpoint
```

**Usage policy / attribution**: depends on the datasets your instance is
built from (OSM, OpenAddresses, Who's On First, geonames, …) and on your
hosting provider's terms. Override `attribution` / `usagePolicyUrl` to match;
see <https://github.com/pelias/documentation/blob/master/data-licenses.md>.

### Honua facade

```ts
import { HonuaGeocodingClient, honuaGeocodingProvider } from "@honua/sdk-js/geocoding";

const client = new HonuaGeocodingClient({ baseUrl: "https://your-honua-server.example" });
const provider = honuaGeocodingProvider(client); // geocode + reverse + suggest
```

Existing `HonuaGeocodingClient` code keeps working unchanged; the provider
wrapper exists so provider-neutral hosts (search UIs, the CLI, agents) can
treat Honua like any other provider.

## Routing

### OSRM

```ts
import { osrmRoutingProvider } from "@honua/sdk-js/routing";

const router = osrmRoutingProvider({
  baseUrl: "https://osrm.example.org",
  profile: "driving", // or "foot", "bicycle", … as exposed by your instance
});

const route = await router.route([
  { longitude: -157.858, latitude: 21.306 },
  { longitude: -157.802, latitude: 21.262 },
]);
// route.geometry: [lon, lat][]  route.distanceMeters  route.durationSeconds  route.legs
```

**Usage policy**: the public demo (`router.project-osrm.org`) and the FOSSGIS
instances (`routing.openstreetmap.de`) are for light, non-commercial use — see
<https://routing.openstreetmap.de/about.html>. Self-host for production.
**Attribution**: `Route data © OpenStreetMap contributors, ODbL 1.0`.

### Valhalla

```ts
import { valhallaRoutingProvider } from "@honua/sdk-js/routing";

const router = valhallaRoutingProvider({
  baseUrl: "https://valhalla.example.org",
  costing: "auto", // or "bicycle", "pedestrian", …
});
```

Leg shapes (Valhalla's 1e-6 encoded polylines) are decoded into plain
`[longitude, latitude]` geometry for you; `decodePolyline` is exported if you
need it directly.

**Usage policy**: the FOSSGIS community instance
(`valhalla1.openstreetmap.de`) expects fair use; self-host for production.
**Attribution**: OpenStreetMap (ODbL), as above.

### Honua facade + esri-compat bridge

```ts
import {
  honuaRoutingProvider,
  osrmRoutingProvider,
  routingProviderToCompatRouteProvider,
} from "@honua/sdk-js/routing";
import { RouteTaskCompat } from "@honua/sdk-js/esri-compat";

// Wrap the existing Honua facade solver (the esri-compat routeProvider shape)
// in the provider contract:
const honua = honuaRoutingProvider(myExistingRouteSolver);

// Or drive esri-compat widgets (RouteTaskCompat / RouteLayerCompat /
// DirectionsCompat) with any RoutingProvider:
const task = new RouteTaskCompat({
  routeProvider: routingProviderToCompatRouteProvider(
    osrmRoutingProvider({ baseUrl: "https://osrm.example.org" }),
  ),
});
```

## CLI

```bash
# Default behavior (Honua locator) is unchanged:
honua geocode "530 South King Street" --limit 3

# Third-party provider — endpoint is always explicit:
honua geocode --provider nominatim --base-url https://nominatim.example.org "530 South King Street"
honua geocode --provider photon --base-url https://photon.example.org "Honolulu" --json
honua geocode --provider pelias --base-url https://pelias.example.org --api-key $PELIAS_KEY "Honolulu"

# Nominatim public-instance policy compliance:
honua geocode --provider nominatim --base-url https://nominatim.openstreetmap.org \
  --user-agent "my-app/1.0 (ops@example.org)" "Honolulu Hale"
```

Table output prints the provider's attribution and usage-policy URL after the
results; `--json` emits the normalized results with `provenance` stamped on
each row.

## Caching and rate limits

Suggest paths should debounce in the UI (see the typeahead example in the
`/geocoding` package docs). The SDK deliberately does **not** persist provider
results: most community usage policies (Nominatim in particular) prohibit
systematic caching/bulk harvesting, and provenance is recorded per result so
downstream stores can honor per-provider terms.

## Testing

Unit tests run against recorded fixtures (`test/fixtures/providers/`) and
never touch the network. The live smoke lane
(`test/provider-live-smoke.test.ts`) is opt-in via
`HONUA_PROVIDER_LIVE_SMOKE=1`, sends exactly one request per test, and sets a
real `User-Agent` for Nominatim.
