# Studio package fixtures (cross-surface parity)

These fixtures are AI-generated Studio packages that exercise the cross-surface
parity contract from `honua-sdk-js#226`: each is shaped exactly as it would be
when produced through an MCP client or the QGIS plugin (note the
`provenance.origin` of `"mcp"` / `"qgis"`), and each can be opened by Console
and inspected by SDK tests through `@honua/app-platform/studio`.

| Fixture | Family | Origin | Notes |
| --- | --- | --- | --- |
| `map-only.v1.json` | `map` | `mcp` | Minimal valid `HonuaMapDocument` with provenance. |
| `dashboard.v1.json` | `dashboard` | `qgis` | `HonuaGeneratedAppManifest` with category + time-series charts. |
| `report.v1.json` | `report` | `mcp` | `HonuaReportPackage`; declares a server-side `report:render` permission. |
| `app.v1.json` | `app` | `mcp` | `HonuaGeneratedAppVersion` wrapping a manifest artifact. |

Every fixture carries a `provenance` envelope (`honua_package_provenance.v1`)
recording prompt, plan, data bindings, and permissions consistently — the same
shape regardless of which surface generated it. `validateStudioPackage(family,
pkg)` from `@honua/app-platform/studio` validates all four against one envelope; see
`test/studio/studio-package-parity.test.ts`.

Permissions flag client-vs-server execution via `clientSide`: a `true`
permission can be satisfied by an SDK browser preview, a `false` one (e.g. the
report's `report:render`) requires server execution. See
`docs/studio-package-parity.md` for the full capability matrix.
