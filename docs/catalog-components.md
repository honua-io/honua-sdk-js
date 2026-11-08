---
type: reference
title: "Experimental catalog components"
description: "Opt-in native catalog search, cards, endpoints and lineage, fixture presentation boundaries, and package verification."
---

# Experimental catalog components

`@honua/components` is a focused split package built from this repository with
`npm run build:split-packages`. It contains native custom elements for catalog
search and Dataset, Layer, Service, Map and App cards. No UI framework or map
renderer is loaded by these entrypoints.
The initial search/cards bundle measures 11,093 minified bytes and 4,148 gzip
bytes with the repository's esbuild settings. Its normal bundle gate allows
10% headroom and rejects renderer, Studio-agent, migration and RPC inputs.

This slice supports fixture development. Registration is disabled by default:

```ts doc-test=compile
import { defineCatalogComponents } from '@honua/components';

defineCatalogComponents({ enabled: true });
```

Importing the package never registers elements. Server-side Node imports are
safe. Registration does not claim `honua-map`; its existing canonical element
remains responsible for map rendering. Release and publication use the normal
repository flow and require release authorization.

## Fixture host integration

Trusted host code sets each element's `client` property. The presentation-only
`CatalogComponentClient` seam lives in `src/catalog-components/presentation.ts`.
It has no transport, authentication implementation, response cache, fixture
fallback or admin credentials. A Development/test adapter can shape draft catalog
fixtures into this view. It is not a server wire contract.
The presentation view requires absolute HTTP(S) links. Trusted adapters resolve
relative server links against that client's server origin, never the embedding
page's origin. The browser fixture serves both origins together for this test.

Live binding awaits the canonical `HonuaClient.listCatalog` and
`HonuaClient.getCatalogItem` projection through `@honua/sdk-js/honua` and the
approved generated contracts. Replace this temporary presentation seam with that
client's supported projection during cutover. Do not create an independent HTTP
client. Turning on registration does not establish server support or authorize
live use. The fixture adapter and its responses stay outside the package.

Set `catalog` plus the corresponding identity attribute on cards: `dataset`,
`layer`, `service`, `map` or `app`. Search supports `catalog`, `kind`, `category`,
`limit` (1–100, default 12) and an accessible `label`. It renders text search,
server-supplied kind facets, title/recently-updated sorting and offset paging.
Additional facet groups, extent/time controls and optional card detail fields
await the contract cutover; this slice does not advertise those controls.

Reads use the supplied visitor-scoped client. The server owns visibility,
public-catalog anonymous ceilings and facet filtering. Cards from a search page
use its permitted projection without issuing individual detail requests. Map and
App cards require a Released version; this slice does not embed viewers.
Unknown kinds and unusable links do not produce navigation targets. Thumbnails
have supplied alt text or a visible kind fallback. Health includes a word.

Client replacement, attribute changes, refresh and disconnect abort pending
requests and remove previous content and structured data. Stale responses cannot
replace a newer view. Hosts must replace/clear the client on authorization or
Environment changes and call `refresh()` on permission invalidations. Restricted
live use remains unsupported until the server's freshness/revocation contract is
bound and qualified; fixture tests do not establish live access enforcement.

## Security and structured data

All untrusted strings are rendered with DOM text APIs. Display links reuse the
SDK's shared HTTP(S) URL validation plus credential-query rejection. Elements
use an external stylesheet, never inline styles or executable scripts. Serve the
package modules and `catalog.css` from origins allowed by the page's strict CSP.
CSS tokens prefixed `--honua-catalog-` customize colors through a trusted external
stylesheet. Templates do not supply styles or executable code.

When a visitor response contains `structuredData`, the library contributes that
server-owned JSON-LD projection to a library-owned inert
`script[type="application/ld+json"]` block in the document head. It uses
`textContent`, escapes `<`, deduplicates subjects, and removes contributions on
replacement/disconnect without deleting server-owned blocks. It never derives
metadata-to-standard mappings from card fields or fetches remote contexts.

The draft catalog fixtures currently have no crosswalk projection. Their cards
therefore emit no JSON-LD until the server supplies it. Collector tests prove
serialization and lifecycle only. DCAT/DCAT-AP shape validation, crawler proof
and server-crosswalk equality remain contract/integration gates.

Events bubble and cross shadow boundaries: `honua-catalog-state-change`
(safe state only), `honua-catalog-query-change`,
`honua-catalog-item-activate` (cancelable), and
`honua-catalog-structured-data-change`. They contain no credentials or denied
response payloads. Studio can use these same properties/events through a thin
host adapter; authoring and release mutations remain outside this library.

## Verification

Focused Vitest tests cover registration, presentation, identity/access cleanup,
request races, paging and inert JSON-LD contribution lifecycle. Browser tests use
actual restrictive response headers, keyboard navigation, axe and a 390px
viewport. These are fixture qualifications, not live server journeys.
The CSP context keeps enforcement enabled throughout. Axe uses a separate
instrumentation context because its stylesheet inspection creates inline styles;
that context checks contrast and semantics in light and dark themes.

Before enabling a live binding, verify canonical installed-package reads on an
immutable live server, public/signed-in visibility and revocation, approved
crosswalk output, and the required live integration workflows. No missing server
binding may turn into fixture data.

## Endpoints and apps using an item

`honua-service-endpoints` accepts `catalog`, exactly one of `service` or `layer`,
an optional comma-separated `protocols` filter, `group="protocol"` and the boolean
`copy` attribute. Without `group` it renders a flat list; `group="protocol"` adds
labeled protocol sections. It renders only safe advertised URLs from `getCatalogItem`'s
optional `endpoints` projection. Copy requires a visitor action and the browser
clipboard permission; success or failure is announced. Successful copies emit
`honua-endpoint-copy` with the normalized safe endpoint URL. No endpoint is synthesized.

`honua-apps-using` accepts the same catalog/item identity, `view="cards|table"`
and `limit` from 1 to 100. It reads the optional `listCatalogAppsUsing` capability
with bounded offset/limit paging, validates the response's catalog and subject,
and accepts only Released Apps and Maps. Missing capabilities render unsupported,
never a regular catalog-search fallback. A shrinking visible total moves to the
last available page with one bounded recovery attempt.

Both elements share the cards/search cancellation lifecycle and external stylesheet.
They contribute only visitor-filtered server crosswalk JSON-LD, clear it on client
replacement/disconnect, and never infer metadata mappings in the browser. Hosts
must replace or clear the client when authorization changes. The fixture adapter
is test-only; canonical transport integration and publication remain pending.
