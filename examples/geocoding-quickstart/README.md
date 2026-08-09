# Address to pin

A map-first public example for the stable `@honua/sdk-js/geocoding` entrypoint. It makes one real
`HonuaGeocodingClient.forwardGeocode()` request, places the selected candidate on MapLibre, and keeps the selected option,
standardized address, score, locator, coordinates, and pin synchronized.

The default and published lanes are deliberately **fixture-only**. This repository does not currently govern an anonymous
public GeocodeServer suitable for a public demo, so the example does not substitute or imply a third-party live endpoint.

## Deterministic fixture lane

```bash
npm install
npm run demo:geocoding:mock
```

The Vite build ships the reviewed response at the exact SDK route:

```text
./rest/services/World/GeocodeServer/findAddressCandidates
```

The relative route remains inside the sample on root and nested static hosts. `mock-server.mjs` serves the same committed
document as JSON during focused browser tests; it does not maintain a second response body. The fixture is a synthetic,
version-controlled set of Honolulu addresses and does not claim freshness or attribution from a public geocoder.

## SDK call

```ts doc-test=skip reason="excerpt continues inside the sample's imported async browser bootstrap"
const geocoder = new HonuaGeocodingClient({
  baseUrl: ".",
  locatorName: "World",
});

const candidates = await geocoder.forwardGeocode("Honolulu civic landmarks", {
  maxResults: 4,
  spatialReferenceWkid: 4326,
});
```

Use a governed Honua GeocodeServer URL and the host's credential/session policy in your own application. This public example
intentionally has no browser credential variables and makes no live-success claim.

## Verification

```bash
npm run demo:geocoding:typecheck
npx vitest run test/geocoding-quickstart.test.ts
npm run demo:geocoding:build
npm run test:playwright:geocoding
```
