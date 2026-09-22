---
name: honua-arcgis-migration
description: Migrate an existing ArcGIS JavaScript app and its service dependencies to Honua using native SDK primitives, agentic code conversion and optional canonical codemods. Use for inventory, conversion, imported-target validation and migration evidence.
release: "2026.1"
stages: []
---

# ArcGIS app and service migration

The outcome is preserved application behavior on Honua services. Agent-written
conversion is valid. Scanner readiness and automatic rewrite percentage measure
tool coverage; neither establishes a working application or SDK feasibility.

## Establish the baseline

Pin the original commit and dependency lock. Run the original application and
freeze requested workflows, known-record expectations and accepted variations.
Inventory imports, dynamic/CDN loading, WebMaps/Portal items, widgets, renderers/
Arcade, auth, operational services, tables, relationships, attachments, CRS and
basemaps. A static import scanner cannot discover all runtime dependencies.

Distinguish retained Esri clients on imported services, mixed assisted conversion,
and complete Honua SDK conversion. Complete conversion must not require the
ArcGIS JavaScript runtime.

## Use canonical tooling where it helps

The canonical JS engine lives in `honua-io/honua-migrate/packages/javascript`.
Its standalone npm CLI is `honua-js-migrate`, a bin of `@honua/honua-migrate`.
`npx` fetches its first argument as a package, so name that package. Pin
`@honua/honua-migrate@<version>` in place of the unversioned package below
for a repeat run.

```bash
npx -p @honua/honua-migrate honua-js-migrate scan ./src
npx -p @honua/honua-migrate honua-js-migrate codemod ./src --target honua-maplibre --report migration-report.json
```

Check the installed CLI's `--help` for supported commands and flags. Codemod is
a dry run unless `--write` is supplied. Review the report before applying changes.
Use `honua-compat` only for behavior the compatibility runtime actually supports.
SDK scripts `scan:arcgis` and `migrate:arcgis` are transition tooling; do not
create another AST engine or copy canonical transforms back into the SDK.

Unsupported constructors, spreads, dynamic options, widget/view-models and Arcade
are prompts for semantic translation or explicit gaps. Do not restructure working
source merely to increase automatic coverage. Never delete required options or
behavior to clear a warning. Preserve evaluation order, closures, reactive state
and lifecycle when translating agentically.

## Map behavior onto native primitives

Read the installed SDK's public types and these repository references as needed:

| Behavior | Native starting point |
| --- | --- |
| Discover/query services | `connect`, Dataset/Source/Query/Result; `docs/guide.md` |
| Render/refresh a source | `/map` mounting; `docs/data-to-map-bridge.md` |
| Picking, popup, synchronized list/table | `/interactions`, selection/inspection; `docs/feature-inspection.md` |
| Persist edits and recover failures | `/contract` edit sessions, sketch/snapping, feature-editor workflow |
| Spatial operations and CRS | `/geometry`; preserve units, geodesic semantics, Z and projections |
| Framework UI and lifecycle | `/react`, `/web-components`, app controller; check maturity and disposal |

Do not infer MapView/SceneView parity from compatibility class names. Use real
renderer picking/projection for screen/map operations; placeholders are not
behavioral evidence. Preserve renderer/label semantics or translate to native
styles. Bounded Arcade expressions can become application code; that does not
establish a general Arcade runtime.

## Import backend dependencies

When backend migration is in scope, use the production service import and
reconciliation workflow in `honua-migrate`, including its documented resume and
uncertain-write limits. Inspect plan/apply help and preserve the task's existing
authorization boundary. Do not blindly retry an uncertain transfer or treat a
polling resume as a transfer restart.

Resolve the dependency closure and map source IDs/URLs to target IDs/URLs.
Reconcile geometry/CRS, fields/domains/subtypes, row identities and complete
paging, tables/relationships and attachments where present. Import duplicate
service references once while preserving distinct layer presentations. Record
data reuse rights independently from sample-code licensing and declare licensed
basemap substitutions. Inaccessible dependencies need an explicit disposition.

Bind the converted app to the imported target. Retained operational reads from
Esri must be declared; they cannot silently satisfy an imported-backend claim.

## Validate and learn

Install exact SDK packages independently, build and execute the frozen browser
scenarios against the converted app and imported data. Assert records, selection/
filter behavior, edits when in scope, loading bounds and visible errors. Capture
console/network failures and traces, residual dependencies, accepted variations,
manual effort and import fidelity. A successful build is only one stage.

For repeat onboarding evaluation, separate deterministic replay of reviewed output
from fresh agent conversion. Fresh agent runs start from original source without
previous converted solutions. Measure backend preparation separately: `fresh-import`
exercises service import; `snapshot-restore` restores a validated database and Honua
configuration into an isolated writable target. Bind snapshots to source inventory,
server image, schema and configuration digests; regenerate on incompatible changes.
Keep secrets outside portable snapshots and run fresh imports periodically. A restored
backend run does not establish fresh-import success. Version reusable SDK/importer/skill
fixes and exercise them in another fresh run. Record every attempt, failure,
intervention, model/prompt/tool version, cost and elapsed time within agreed
budgets. Different generated code can satisfy the same behavior.

Read-only samples do not establish persistent editing, offline, attachment writes,
secured-service or 3D support. Keep unsupported workflows explicit and file focused
primitive/importer issues from demonstrated gaps.
