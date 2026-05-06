# Honua Geocoding Quickstart

Small browser sample for the SDK geocoding surface. It demonstrates:

- forward geocoding through `HonuaGeocodingClient.forwardGeocode()`
- reverse geocoding from a clicked MapLibre point through `HonuaGeocodingClient.reverseGeocode()`
- typeahead suggestions through `HonuaGeocodingClient.suggest()`
- visible audit rows that map each interaction to its GeocodeServer endpoint

## Fast Local Run

The fixture lane is same-origin and does not need a live Honua server.

```bash
npm install
npm run demo:geocoding:mock
```

The script builds the app, serves it locally, and serves fixture responses for:

- `GET /rest/services/World/GeocodeServer/findAddressCandidates`
- `GET /rest/services/World/GeocodeServer/reverseGeocode`
- `GET /rest/services/World/GeocodeServer/suggest`

The local URL is printed as `geocodingMockUrl=http://127.0.0.1:PORT`.

## Live Honua Run

```bash
npm run demo:geocoding
```

Supported env vars:

- `VITE_HONUA_GEOCODING_BASE_URL`: Honua base URL. Omit it for the same-origin fixture lane.
- `VITE_HONUA_GEOCODING_LOCATOR_NAME`: GeocodeServer locator service. Default: `World`.
- `VITE_HONUA_GEOCODING_INITIAL_QUERY`: startup forward search. Default: `Honolulu Hale`.
- `VITE_HONUA_GEOCODING_COUNTRY_CODES`: forwarded as `countryCode`. Default: `US`.
- `VITE_HONUA_GEOCODING_MAX_RESULTS`: forwarded as `maxLocations`. Default: `5`.
- `VITE_HONUA_GEOCODING_MAX_SUGGESTIONS`: forwarded as `maxSuggestions`. Default: `5`.
- `VITE_HONUA_GEOCODING_API_KEY`: optional API key forwarded as `X-API-Key`.
- `VITE_HONUA_GEOCODING_BEARER_TOKEN`: optional bearer token forwarded as `Authorization: Bearer ...`.

## Network Contract And Audit Mapping

The sample uses SDK methods only for GeocodeServer calls:

| User action | SDK surface | Endpoint |
| --- | --- | --- |
| Address search | `HonuaGeocodingClient.forwardGeocode()` | `/rest/services/{locatorName}/GeocodeServer/findAddressCandidates` |
| Map click | `HonuaGeocodingClient.reverseGeocode()` | `/rest/services/{locatorName}/GeocodeServer/reverseGeocode` |
| Typeahead input | `HonuaGeocodingClient.suggest()` | `/rest/services/{locatorName}/GeocodeServer/suggest` |

The SDK already exposes suggest as a first-class API, so this sample has no demo-local fallback for typeahead.
Searches and clicked-coordinate lookups are treated as ad hoc user requests and are not cached by the example.

For browser smoke tests and troubleshooting, the runtime exposes `window.__HONUA_GEOCODING_DEMO__` with readiness,
result counts, the resolved locator, audit rows, and focused `runForward()`, `runReverse()`, and `typeahead()` helpers.

## Verification

```bash
npm run demo:geocoding:typecheck
npm test -- test/geocoding-quickstart.test.ts
npm run demo:geocoding:build
npm run test:playwright:geocoding
```
