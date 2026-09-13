---
type: reference
title: "SDK market and migration audit — September 13, 2026"
description: "A source and backlog audit of native migration primitives, adoption priorities, and first-release scope."
---

# SDK market and migration audit — September 13, 2026

The technical direction is sound. Honua can become the application and data layer that makes open web GIS easier to adopt. The highest-return next step is to prove and polish complete customer workflows using the existing primitives. More protocol names, compatibility constructors, and experimental surfaces will contribute less until that adoption path works reliably.

**Agent-assisted conversion is a valid primary migration path. Deterministic codemod coverage is not the release criterion.** An agent may rewrite application structure, framework integration, widgets, and ordinary business logic. The resulting application must preserve the agreed behavior, use available runtime capabilities, and pass behavioral validation. Reproducible validation is valuable even when code generation is nondeterministic.

## Audit basis and limits

- Fresh SDK worktree from fetched trunk: `9ce185118659a37b545821e7a74678ec6b781215`.
- Fresh migration worktree from fetched trunk: `2fcde9bbcf208afb0c03d81ee7e8c26d8c5ee707`.
- The original SDK checkout had 221 modified/deleted/untracked status entries and was left untouched.
- Reviewed all 74 open SDK and 22 open migration issues, selected recent closed issues and open implementation PRs, the release outcome specification, support manifests, migration evidence, and targeted SDK/migration source paths.
- npm registry metadata served `@honua/sdk-js@0.1.9-beta.0`; GitHub lists migration CLI release `honua-migrate-v0.7.1`. The separate JavaScript migration source package is `@honua/honua-migrate@0.1.3-beta.0`. These version numbers describe different products.
- Locally ran the repository's `npm run check` through an isolated `@biomejs/biome@1.9.4` tool installation: **1,449 files passed**, no fixes. No SDK source or package metadata was changed.
- Inspected [successful SDK CI at the audited SHA](https://github.com/honua-io/honua-sdk-js/actions/runs/34778156326), [SDK Verification](https://github.com/honua-io/honua-sdk-js/actions/runs/34778156363), and [migration CI](https://github.com/honua-io/honua-migrate/actions/runs/34664355939). A separate [browser-impact observer failed policy/identity fixture validation](https://github.com/honua-io/honua-sdk-js/actions/runs/34780927975); this is distinct from the main SDK CI result.
- Executed the public endpoint query reproduction below. Did not run a fresh full build, browser suite, customer migration, authenticated Honua deployment, or installed-candidate certification. Existing receipts and PR descriptions are identified as such.
- This is a technical/product audit, not a market-share forecast. No verified customer retention, conversion, revenue, or current adopter roster was established here.

## Are the migration primitives present?

**Yes for a substantial, bounded 2D cohort:** parcel/service viewers, asset lookup, map-and-table applications, and selected operational/editing workflows. Feasibility is stronger than the deterministic conversion percentages suggest. Production equivalence still depends on the specific application's data, cartography, authentication, interaction, and backend requirements.

| Required behavior | Available foundation | What agent conversion can do; remaining boundary |
| --- | --- | --- |
| Connect to existing ArcGIS or open services | Protocol-neutral Source/Query/Result, GeoServices and OGC adapters, schema/capability discovery | Rewrite data access while keeping the current backend. Validate actual service capabilities, paging, CRS and authentication. A Honua server is not required for the supported public-protocol path. |
| Render layers and operate the map | Native MapLibre mounting, style/runtime modules, lifecycle handles, bounded GeoJSON and query-tile strategies | Replace MapView construction and lifecycle with native mounting. Large datasets need a real tile endpoint or bounded data strategy; an agent cannot create server capabilities by changing imports. |
| Click, identify, hover, highlight and select | `hitTestMap`, native automatic mount integration, shared selection/filter primitives, feature inspection | Rewrite interaction handlers to real renderer APIs. Do not assume every compatibility method implements ArcGIS runtime behavior. |
| Popup, search, table and details UI | Inspection workflow, component/table engines, geocoding providers, ordinary framework/DOM composition | Rebuild UI and application glue. Bounded attachment/relationship loaders need host adapters today; a polished universally interchangeable widget suite is not established. |
| Geometry, projection and measurement | Turf/proj4-backed geometry operations, snapping, sketch/runtime bindings | Convert units and app-specific geometry logic. Verify CRS and geodesic/planar intent. Native measurement formatting/unit control still has a scoped first-release gap. |
| Basic create/update/delete | `createEditSession`, domain/field validation, optimistic hooks, partial-failure handling, sketch and editor workflow modules | Implement selected workflows on supported services. Attachment lifecycle, durable offline replay and complete conflict handling still need workflow-specific qualification. |
| Authentication and framework integration | OAuth2/PKCE and token-provider APIs, request/auth compatibility, React hooks and lifecycle bindings | Rewrite sign-in plumbing and framework state. Existing portal entitlements, identity policy, CORS and protected resources must work against the actual chosen services. |
| WebMap and cartography conversion | WebMap parser, style conversion, renderer/label/popup conversion and structured manual gaps | Rewrite supported styles, fetch dynamic content, translate bounded expressions into ordinary code. Arbitrary Arcade execution, unsupported cartography and Portal application hosts are not supplied by the converter. |
| Realtime operations | Subscription, cursor/resume and shared application-state primitives | Rewire the app while preserving freshness, cancellation, reconnect and authority behavior. Server events and authorization must be verified; the incident dashboard remains realtime. |
| Advanced Esri functionality | Some native Cesium and GP capabilities exist separately | General SceneView parity, Utility Network, Parcel Fabric/LRS, arbitrary Arcade/Experience Builder compatibility and offline geodatabase behavior cannot be promised from these primitives. Scope or retain the required external service/runtime. |

Useful source evidence: [native mounting](../../src/map/source-to-maplibre.ts), [native hit testing](../../src/interactions/hit-test.ts), [automatic interaction binding](../../src/map/automatic-mount-integration.ts), [edit sessions](../../src/contract/edit-session.ts), [editor workflow](../../src/web-components/feature-editor-workflow.ts), [WebMap conversion](../../src/map/webmap-maplibre.ts), [geometry](../geometry.md), [React](../react.md), [bounded inspection limitations](../feature-inspection.md).

### A concrete reason to prefer native behavior mappings

In [`MapViewCompat`](../../src/esri-compat/map-view.ts), `toMap()` at line 873 copies x/y and `toScreen()` at line 884 does the inverse identity mapping. `hitTest()` at line 891 maps `this.popup.features`; it does not query rendered pixels. The unit test explicitly exercises this popup-result bridge.

The native [`hitTestMap`](../../src/interactions/hit-test.ts) calls `queryRenderedFeatures` and uses renderer unprojection; [`automatic-mount-integration`](../../src/map/automatic-mount-integration.ts) exposes it on the mounted workflow. Thus the primitive needed to convert real click/identify behavior exists, while a mechanical constructor rename alone is insufficient. An agent should choose the native interaction path and verify click results after pan/zoom, including an empty location.

Likewise, [`SceneViewCompat`](../../src/esri-compat/scene-view.ts) extends the 2D MapView compatibility class. The class name is not evidence of equivalent 3D functionality. Native Cesium work is a separate capability and qualification decision.

## Can an Esri customer migrate?

There are three distinct adoption paths:

1. **Replace the web client while retaining ArcGIS services.** This is the strongest initial SDK proposition. Agent-assisted conversion can map ordinary 2D app behavior onto Honua/MapLibre, retain the customer's services and verify supported operations. Backend replacement need not be a prerequisite.
2. **Replace selected services while retaining an Esri client.** The migration CLI has real service discover/plan/apply/job operations, but working app handoff and import fidelity are separate outcomes. [migrate #92](https://github.com/honua-io/honua-migrate/issues/92) and [#95](https://github.com/honua-io/honua-migrate/issues/95) correctly require mappings, reconciliation and recovery limits. This is coexistence, not removal of the Esri runtime.
3. **Replace both client and backend.** Combine the two paths only for a frozen app/service profile. Validate schema, identifiers, relationships, attachments where required, styles, queries, authorization and any writes. Record unsupported behavior explicitly. Do not describe endpoint switchback as data restoration or imply dual-write consistency.

The retained [August 4 third-party corpus](../oss-arcgis-corpus-readiness.md) contains six assisted apps, 75/171 rewritten in-scope call sites, and 146 out-of-scope module hits. These are scanner/conversion-effort observations, not percentages of SDK functionality or proof that those apps cannot be converted by an agent. Its [one deeper build case](../oss-arcgis-corpus-post-codemod-build.md) passes the bundler but keeps ArcGIS dependencies and introduces two additional diagnostic findings; it is not full-conversion browser proof.

[SDK PR #1663](https://github.com/honua-io/honua-sdk-js/pull/1663) adds useful installed-tarball browser infrastructure but explicitly retains local fixtures/local packing and outstanding live-candidate/independent-app work. [Migration PR #147](https://github.com/honua-io/honua-migrate/pull/147) adds a React conversion fixture. Neither should be counted as three independently validated complete customer conversions.

Keep the existing three-app outcome in [release #325](https://github.com/honua-io/honua-release/issues/325), [SDK #1662](https://github.com/honua-io/honua-sdk-js/issues/1662), and [migrate #142](https://github.com/honua-io/honua-migrate/issues/142). Permit agent-written changes and reviewed application rewrites in those cases. Measure preserved behavior, engineering hours, residual dependencies and required SDK additions, with no minimum automatic-rewrite ratio.

## Findings that should shape the first cut

**1. Spatial correctness: confirmed first-impression failure.** The README uses `envelope(-125, 24, -66, 50)` without a spatial reference. [`envelope`](../../src/core/spatial-filter.ts) only adds a reference when supplied; the older GeoServices compiler carries no separate input-SR field for this path. Against the README's Census FeatureServer, two otherwise identical read-only count queries returned **0 without `inSR` and 49 with `inSR=4326`** during this audit. This independently confirms the wire-level reproduction in [#1668](https://github.com/honua-io/honua-sdk-js/issues/1668), not a fresh execution of the entire SDK snippet. Promote it into first-cut triage and validate semantics on non-WGS84 layers.

**2. Consumer security contract: still open.** Both trunk and public `0.1.9-beta.0` permit `maplibre-gl: ^5.0.0 || ^6.0.0`; the development dependency is already `^6.4.1`. [The upstream advisory](https://github.com/advisories/GHSA-jrc7-96c5-q579) marks versions through 6.4.0 affected by an attribution sanitizer XSS and 6.4.1 patched. This permits vulnerable consumer resolutions; it does not mean every current install chooses a vulnerable version. Resolve [#1671](https://github.com/honua-io/honua-sdk-js/issues/1671) across published peer contracts and supported distribution paths. Do not treat a development lockfile bump as closing it.

**3. Installed delivery remains a gate.** The latest committed [Windows bundle replay](../installed-first-map-budget.md) reports 2,050,733 JS / 550,795 gzip bytes against frozen limits of 1,990,000 / 524,000. The resolver repair is useful but [#1584](https://github.com/honua-io/honua-sdk-js/issues/1584) remains failed. The README also still contains the multi-bin `npx` invocation in [#1596](https://github.com/honua-io/honua-sdk-js/issues/1596), with a fix in open PR #1700. Publish a coordinated, installable set, run the actual documented paths and retain the results through [#39](https://github.com/honua-io/honua-sdk-js/issues/39).

**4. Agent migration guidance should preserve behavior first.** The current [migration skill](../../skills/honua-arcgis-migration/SKILL.md) tells agents to reshape code for the codemod, reach `readiness=ready`, and, for unsupported properties, “delete the unsupported ones.” It also describes the former SDK-owned CLI as canonical. That is a poor target for agent-assisted conversion: deleting behavior can make a scanner green. Update guidance to use `honua-js-migrate` for inventory/optional safe rewrites, map required behaviors onto native primitives, preserve business semantics, and accept only validated outcomes. Unsupported behavior requires a scoped product decision or implementation, not silent removal. Extend existing skills/evals rather than build another agent framework.

**5. Runtime maturity is uneven inside a broad surface.** The support manifest reports 22 supported, 26 experimental and 18 deprecated entrypoints. Even [mountSource](../data-to-map-bridge.md) is documented experimental within a stable entrypoint. The [component reference](../application-components-reference.md) records outstanding accessibility/browser/budget gates and no recorded live lane. Freeze the exact primitives used by launch apps and qualify them; don't infer production status from an export or component count.

## Highest-return execution order

| Order | Focus | Existing ownership and finish line |
| --- | --- | --- |
| 1 | Fix what breaks an evaluation immediately | SDK #1668, #1671, #1596, #1572, #1584, #39: correct spatial results, patched supported peers, copyable install/scaffold commands, compatible packages, bounded actual first-map bytes. |
| 2 | Convert three representative apps, with agents allowed | SDK #1662 / migrate #142: a real existing app, widget-heavy behavior and a framework/TypeScript case, which may overlap. Baseline versus migrated browser assertions, published package identities, no hidden ArcGIS dependency for full conversion, operator effort recorded. |
| 3 | Remove repeated native primitive/integration gaps discovered in those apps | Promote bounded fixes such as #1419 measurement fidelity; use #1298/#1300/#1420 for recurring inspection/table/editing needs. Add native mapping recipes for picking, projection, styles, state and auth. Do not expand entire epics to resolve one missing behavior. |
| 4 | Start customer learning and distribution immediately | Existing sales #14/#64 and SDK #499/#675. Recruit scoped design partners, offer one-app assessments, show a deployable before/after example and maintain ecosystem integrations. Keep recruiting separate from technical RC gates. |
| 5 | Productize the common application experience | A coherent map/table/search/details/edit workflow, keyboard/focus behavior, React integration, theming, performance and diagnostics. Use #1294's existing children; prioritize reported user friction. |

This ranking is qualitative: breadth, repeat use, conversion friction and blast radius justify it. There is no measured revenue model behind a numerical ROI score. For SDK capacity, a reasonable initial planning allocation is roughly 60% release-path/runtime fixes, 25% real app conversions and feedback, and 15% docs/distribution. Revisit it from observed conversion work.

## First release versus next release

Calendar **2026.1/2026.2** and package **0.1/0.2** are independent. The SDK already publishes a 0.1 beta line; the migration CLI has its own 0.7 line. Do not force them to share a version or treat a version bump as certification.

| First commercial/adoption cut (2026.1 focus) | Following focused expansion (2026.2 candidates) |
| --- | --- |
| A dependable native 2D app path on existing GeoServices/OGC endpoints | Cohesive application shell, inspection/table/filters and production editing depth driven by adopter needs |
| Agent-assisted conversion accepted; validated app behavior required | Expand difficult legacy/custom-widget conversion from measured gaps, including native recipes before bespoke codemods |
| Install/scaffold/docs, spatial correctness, safe peers, auth/error behavior and frozen package budgets | Real package boundaries and leaner distribution (#1413/#1414/#1410); remove duplicated migration implementation when transition commitments allow |
| Three complete scoped migration outcomes, including the independent/framework/widget coverage already required | Sustained adopter soak and stable-contract graduation through #675/#385 |
| Backend handoff for the declared import profile, preserving .NET-first import fidelity in the platform plan | Broader Portal/content migration, attachments/offline/conflicts only as selected customer workflows justify |
| Existing required CLI/MCP/portable-map/GP/realtime checks only where the launch profile requires them | Deeper agent UX, 3D, warehouse and scientific raster work selected individually from demand |

The 47 SDK issues carrying `release/2026.2` are a ranked pool, not a credible single-release commitment. Thirty-five open SDK issues carry `state/blocked`; issue status also includes work whose implementation partly exists but whose qualification/publication is incomplete. Reconcile by outcome and remaining evidence, not by assuming open means unimplemented.

Protect the first cut from new 3D, warehouse, generalized Arcade, offline and agent-platform scope unless a selected launch app requires it. The existing [release #325](https://github.com/honua-io/honua-release/issues/325) already takes this direction; finish its bounded outcomes rather than create another umbrella or certification system. Do not delay external learning until the eight-week graduation program completes.

For a later **package 0.2**, remove only the shims whose documented conditions are satisfied. The [SDK migration forwarder](../../src/migration-entry.ts) promises at least two migration-tool minor releases and 90 days, and no removal before migration-tool 1.2. That clock is distinct from the app-platform shim policy. Keep stable/experimental contracts understandable to agents and customers.

## Positioning and proof

Lead with: **Build and modernize GIS applications on open web technology, keeping your existing services while you choose what to replace.** A portable, typed GIS application layer is a defensible direction. Its value must show up as less integration work, reliable behavior and a supported upgrade path.

MapLibre already has [plugins for many component capabilities](https://maplibre.org/maplibre-gl-js/docs/plugins/). Honua's opportunity is coherent data, capability, interaction and lifecycle contracts with working app recipes. An agent-friendly SDK and migration knowledge can accelerate adoption; generic agent functionality alone is not demonstrated differentiation.

Esri's current [component transition page](https://developers.arcgis.com/javascript/latest/components-transition-plan/) confirms widget deprecation from 5.0 and future removal, conditional on native component replacement. The audited page does not currently substantiate a blanket Q1 2027 removal deadline. Use the modernization opportunity without claiming existing customer applications have already stopped working.

Track: time to useful map on the customer's service; time to a behaviorally equivalent migrated app; human correction hours; runtime blockers per app; residual Esri dependencies; four/eight-week continued use; and support burden. Codemod ratios, raw test totals and package downloads are supporting signals, not the product outcome.

No backlog labels, issue bodies, product code, releases, or external messages were changed by this audit. Recommendations reuse existing owners; this document records the analysis rather than creating a new workstream.
