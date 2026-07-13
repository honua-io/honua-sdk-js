# Go-to-market strategy 2026: three lanes above the kernel

Status: **proposed** on 2026-07-12. This decision complements the accepted
[north-star application-kernel contract](./north-star-sdk-application-kernel.md)
and the [1.0 scope split](./scope-split-and-1.0.md). The kernel ADR defines
*what we build*; this ADR defines *where we compete and in what order*. It is
the strategy companion to the category-leadership program in
[`honua-sdk-js#384`](https://github.com/honua-io/honua-sdk-js/issues/384).

## Market snapshot (July 2026)

A four-track competitive assessment (source-level audit of this repo plus
market briefs on Esri, Mapbox/MapLibre, and CARTO/deck.gl/OpenLayers/Leaflet/
Cesium/Google) found:

- **The rendering war is settled.** MapLibre is the open 2D engine of record
  (~3.25M npm downloads/week, 3.7x YoY — the standout gainer), Cesium owns 3D,
  Mapbox owns visual polish behind per-load pricing. Competing as a renderer
  is a losing move; the kernel ADR already declines it.
- **The open stack has no integration layer.** MapLibre + PMTiles/OpenFreeMap
  commoditized rendering and basemaps, but developers still hand-roll service
  clients, styling, UI, editing, and geocoding. Esri itself now documents the
  "MapLibre for rendering, ArcGIS for data" hybrid. Nobody owns the glue.
- **Esri is forcing its own users to rewrite.** All classic widgets were
  deprecated at ArcGIS JS SDK 5.0 (Feb 2026) and are "planned for removal from
  the SDK as early as Q1 2027" at 6.0, together with AMD/`require()`. Every
  ArcGIS JS app faces a forced migration decision inside ~9 months. This is a
  time-limited acquisition window that `honua-migrate` is uniquely positioned
  to harvest.
- **Every agent/MCP offering is a paid-platform on-ramp.** Mapbox MCP feeds
  Mapbox APIs; CARTO agents require the CARTO warehouse platform; Esri AI
  components require signed-in ArcGIS named users with no LLM choice; Google
  grounds into Gemini. There is no open, vendor-neutral agentic map SDK. Honua
  ships the only thing in the market shaped like one (query planner,
  agent-tools, agent-safety, platform-free MCP server).
- **Honua's audited position:** protocol clients A−, ArcGIS migration B+,
  agent/MCP surface B+, DX discipline A− — against deficits in 3D (C+,
  experimental), offline (D+, spec without engine), UI kit (C+, departing to
  app-platform), and visualization breadth (B−). Adoption is the larger gap:
  ~511 downloads/month versus MapLibre's 3.25M/week.

## Decision

Honua SDK JS competes as **the integration layer above interchangeable open
renderers**, and invests go-to-market effort in three lanes, in this priority
order:

### Lane 1 — Harvest the Esri widget cliff (time-boxed, now → Q1 2027)

When a team is forced to rewrite anyway, "rewrite onto the open stack with a
codemod" competes head-to-head with "rewrite onto Esri web components," and
Esri's own docs legitimize the hybrid. Work: a widget-removal survival guide,
widget-usage detection and 6.0-readiness reporting in the migration scanner,
editing snapping, terra-draw-based interactive sketch, a survival-tier widget
set (in `@honua/app-platform`, per the accepted scope split), and positioning
that says plainly: *your widgets are dying anyway.*

We do **not** chase SceneView/3D migration parity. Esri's 3D moat is real; we
say so explicitly. Candor is the brand and it buys trust for the 2D claim.

### Lane 2 — Be the batteries for MapLibre (continuous)

The affirmative positioning: **"MapLibre gives you the map. Honua gives you
everything else."** Work: a standalone data→map bridge that needs no
MapPackage and no Honua server (builds on the kernel `mount()` and #391
discovery), first-class renderer objects (class breaks, unique value, heatmap,
cluster) with temporal playback, provider-pluggable geocoding/routing so the
capability class is not Honua-facade-bound, `@honua/react` depth worthy of the
`@vis.gl/react-maplibre` ecosystem, and deliberate distribution (plugin
directories, ecosystem examples, published benchmarks). At current adoption,
every discovery surface matters more than any single feature.

### Lane 3 — Own the open agentic-GIS SDK (12–18 months)

The vendor-neutral answer to `@carto/agentic-deckgl` and the Mapbox/Esri MCP
on-ramps: natural language compiling to the same typed, inspectable query plan
human code uses (per the kernel ADR's "no opaque AI execution path"), executed
under agent-safety envelopes, against any standards-speaking server. Work: a
natural-language map-control layer, a coding-agent evaluation harness that
measures whether assistants produce *working* Honua code on the first try, and
promotion of agent-tools/agent-safety out of `@experimental` once exercised.

## Posture notes (existing backlog unchanged)

- **Offline (#396), production Cesium 3D (#395), deck.gl expansion (#388)**
  stay `roadmap:later`/`roadmap:next` as filed. This ADR adds no urgency to
  them; the assessment found none of the three lanes depends on them. Offline
  is excluded from the 1.0 narrative until a real storage engine is funded.
- **Realtime WebSocket/delta work** remains covered by #393.
- **1.0 timing gains a market constraint:** the stable tier should freeze
  *before* ArcGIS JS SDK 6.0 ships (planned Q1 2027) so migrators land on a
  frozen contract.

## Success metrics

- Oct 2026: ≥5K downloads/month across `@honua/*`; ≥3 public migration case
  studies; survival guide and readiness report shipped.
- Q1 2027 (Esri 6.0): ≥25K downloads/month; 1.0 stable tier cut; measurable
  migration-funnel conversions from the assess/readiness tooling.
- 2027: coding-agent eval pass-rate published and competitive; the NL
  map-control layer is the documented open alternative in the agentic-GIS
  category.

## Alternatives considered

- **Compete on renderer features** (3D, visual effects): rejected — settled
  market, contradicts the kernel ADR, and the audit grades confirm we would
  compete from weakness.
- **Enterprise-platform pivot (CARTO's path):** rejected for the SDK — it
  abandons the open-developer wedge that MapLibre's momentum is creating, and
  Honua Server already carries the platform story.
- **Single-lane focus (migration only):** rejected — the widget-cliff window
  closes; Lanes 2 and 3 are what migrated users stay for.
