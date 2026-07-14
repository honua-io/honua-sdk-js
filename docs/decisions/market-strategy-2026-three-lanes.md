# Go-to-market strategy 2026: three lanes above the kernel

Status: **proposed** on 2026-07-12. Revisit no later than ArcGIS JS SDK 6.0 GA
(planned Q1 2027), or immediately if that timeline moves materially. This
decision complements the accepted
[north-star application-kernel contract](./north-star-sdk-application-kernel.md)
and the [1.0 scope split](./scope-split-and-1.0.md). The kernel ADR defines
*what we build*; this ADR defines *where we compete and in what order*. It is
the strategy companion to the category-leadership program in
[`honua-sdk-js#384`](https://github.com/honua-io/honua-sdk-js/issues/384); the
lane epics are [#486](https://github.com/honua-io/honua-sdk-js/issues/486),
[#487](https://github.com/honua-io/honua-sdk-js/issues/487), and
[#488](https://github.com/honua-io/honua-sdk-js/issues/488).

## Market snapshot (July 2026)

A four-track competitive assessment (source-level audit of this repo plus
market briefs on Esri, Mapbox/MapLibre, and CARTO/deck.gl/OpenLayers/Leaflet/
Cesium/Google) found:

- **The renderer boundary is deliberate.** MapLibre is the default open web
  renderer and now spans 2D, globe, terrain, building extrusions, and custom 3D
  layers; Cesium remains the specialist for high-precision WGS84, 3D Tiles, and
  deep temporal scenes. Competing as another renderer would dilute the kernel.
  Sources: [MapLibre GL JS](https://maplibre.org/projects/gl-js/) and
  [CesiumJS](https://cesium.com/platform/cesiumjs), verified 2026-07-13.
- **The open stack has fragmented integrations, not an empty shelf.**
  MapLibre's official plugin catalog already lists geocoding, routing, drawing,
  Esri/OGC sources, COG, and PMTiles integrations. The opportunity is to unify
  discovery, semantic query, capability truth, planning, fidelity, and
  lifecycle behind one maintained contract rather than claiming those pieces
  do not exist. Source: [MapLibre plugins](https://maplibre.org/maplibre-gl-js/docs/plugins/),
  verified 2026-07-13.
- **The Esri migration window is real but scoped.** ArcGIS Maps SDK 5.1 says
  classic widgets were deprecated at 5.0 and removal is planned to begin with
  6.0 as early as Q1 2027; `require()` is also deprecated and may be removed.
  Existing widget applications continue on 5.x, and moving UI to components
  does not replace the core maps, layers, renderers, or most view logic. The
  acquisition target is therefore widget-, AMD-, or deprecated-API-dependent
  applications already funding modernization, not every ArcGIS application or
  a mandatory full rewrite. Sources: [5.1 release notes](https://developers.arcgis.com/javascript/latest/release-notes/)
  and [component migration](https://developers.arcgis.com/javascript/latest/migrating-to-components/),
  verified 2026-07-13.
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
  ~511 downloads/month versus MapLibre's ~14M/month (3.25M/week).

## Decision

Honua SDK JS competes as **the integration layer above interchangeable open
renderers**, and invests go-to-market effort in three lanes, in this priority
order:

### Lane 1 — Harvest the Esri widget cliff (time-boxed, now → Q1 2027)

When a widget-, AMD-, or deprecated-API-dependent team must modernize for 6.0,
"move the affected UI onto the open stack with a codemod" competes with "move
the affected UI onto Esri web components." Work: a widget-removal survival
guide, usage detection and 6.0-readiness reporting in the migration scanner,
editing snapping, terra-draw-based interactive sketch, and a survival-tier
widget set (in `@honua/app-platform`, per the accepted scope split). Positioning
must distinguish the affected UI/import surface from core ArcGIS code that can
remain unchanged.

We do **not** chase SceneView/3D migration parity. Esri's 3D moat is real; we
say so explicitly. Candor is the brand and it buys trust for the open-kernel
claim.

### Lane 2 — Be the batteries for MapLibre (continuous)

The affirmative positioning: **"MapLibre renders the map. Honua connects,
queries, explains, and mounts the data."** Work: a standalone data→map bridge that needs no
MapPackage and no Honua server — a public endpoint to a styled map in ten or
fewer application lines and under five minutes of setup, the #384 bar —
building on #390 (the production MapLibre adapter / source-to-map workflow
that implements the #384 `mount()` front door) and #391 discovery;
first-class renderer objects (class breaks, unique value, heatmap, cluster)
with temporal playback; provider-pluggable geocoding/routing so the
capability class is not Honua-facade-bound; `@honua/react` depth worthy of
the `@vis.gl/react-maplibre` ecosystem; and deliberate distribution (plugin
directories, ecosystem examples, published benchmarks). All such additions
ship as optional peers or in `@honua/app-platform`, never as stable-core
runtime dependencies, preserving the one-lightweight-runtime-dependency
posture. At current adoption, every discovery surface matters more than any
single feature.

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
- **Realtime WebSocket/delta work** remains covered by #393; the bridge and
  temporal-playback work must adopt #393's snapshot-plus-delta semantics
  rather than inventing a second realtime model.
- **1.0 timing gains a market constraint:** the stable tier's surface is
  already API-gated; the **1.0 semver cut** (the durable break/removal
  guarantee) should land *before* ArcGIS JS SDK 6.0 ships (planned Q1 2027)
  so migrators land on a semver-frozen contract.

## Resourcing and capacity

These lanes are prioritized precisely because capacity is the binding
constraint (the scope-split ADR's founding finding: "39 entrypoints maintained
by effectively one author is unsustainable"). Lane 1 is time-boxed and staffed
first; Lane 2 proceeds continuously at whatever throughput remains; Lane 3 is
deliberately paced (12–18 months) and does not draw resource before the Esri
window closes. No lane assumes headcount that does not exist. If forced to
reprioritize, Lane 1's closing window is the forcing function; Lane 2 is the
floor that is never dropped.

## Success metrics

- Oct 2026: ≥5K downloads/month across `@honua/*`; ≥3 public migration case
  studies; survival guide and readiness report shipped.
- Q1 2027 (Esri 6.0): ≥25K downloads/month; 1.0 semver cut landed; measurable
  migration-funnel conversions from the assess/readiness tooling.
- 2027: coding-agent eval pass-rate published and competitive; the NL
  map-control layer is the documented open alternative in the agentic-GIS
  category.

The download targets are step-changes from today's ~511/month and are
deliberately aggressive: they are predicated on the widget-cliff funnel
(scanner → survival guide → codemod) plus plugin-directory/ecosystem listings
landing, not on organic drift. They are tracked monthly as a health signal;
missing them triggers the strategy revisit, not silent target adjustment.

## Risks

- **The Esri 6.0 date slips or widget removal softens.** Lane 1's urgency is
  keyed to Esri's schedule, not ours. Mitigation: Lane 2 is the continuous
  floor and does not depend on the cliff; Lane 1 assets (scanner, guide,
  snapping, sketch) remain durable migration tooling at any removal date.
- **MapLibre governance or strategic shift.** Lane 2 rides MapLibre's
  momentum; a licensing or governance rupture there would force a re-plan.
  Considered low-probability (multi-vendor sponsorship, OSS governance), and
  the protocol/data layer is renderer-neutral by design.
- **Adoption targets miss.** The metrics are measured, dated, and falsifiable;
  because the lanes are independent, a miss degrades the strategy to a slower
  version of itself rather than invalidating it. The scheduled revisit is the
  correction point.

## Alternatives considered

- **Compete on renderer features** (3D, visual effects): rejected — mature
  specialist projects already own those engines, the move contradicts the
  kernel ADR, and the audit confirms we would compete from weakness.
- **Enterprise-platform pivot (CARTO's path):** rejected for the SDK — it
  abandons the open-developer wedge that MapLibre's momentum is creating, and
  Honua Server already carries the platform story.
- **Single-lane focus (migration only):** rejected — the widget-cliff window
  closes; Lanes 2 and 3 are what migrated users stay for.

## Consequences

Positive:

- One coherent go-to-market story tied to the accepted kernel boundary: the
  kernel ADR says what we build, this ADR says who it is for and when.
- The backlog gains a scheduling spine: time-boxed Lane 1 first, continuous
  Lane 2, deliberately paced Lane 3 — instead of feature work competing
  undifferentiated for one maintainer's time.
- Explicit non-goals (renderer features, 3D parity, platform pivot) prevent
  quiet scope creep into mature specialist markets.

Costs:

- Three lanes still compete for effectively one maintainer; the resourcing
  section bounds but does not remove that tension.
- Lane 1's value decays on Esri's schedule, not ours — work parked behind it
  inherits that risk.
- Publishing dated, falsifiable adoption targets creates reputational cost if
  they are missed, which is accepted deliberately as a forcing function.
