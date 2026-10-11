---
type: index
---

# Local agent credential live evidence

[The receipt](2026-10-11-receipt.json) completes the live candidate acceptance
criterion for [issue 2003](https://github.com/honua-io/honua-sdk-js/issues/2003).
The implementation and failure-path tests landed in
[PR 2002](https://github.com/honua-io/honua-sdk-js/pull/2002).

On 2026-10-11, SDK source `1733904b813f02d43743b036da0d3785c9a1e922`
ran its real local installer against server source
`93cad86ec4fb28fba3ff0b9358059d86aa55dde5`, image digest
`sha256:785de2ae7f72e6277ce62aa1ece4f08ee0425970b71c47f9f4843c0baae2c8db`.
Docker's running image identity and OCI revision were checked. The server carries
the S2 wildcard implementation from
[server PR 5740](https://github.com/honua-io/honua-server/pull/5740).
MCP initialization identified `honua.operator.mcp` version `v1`, protocol
`2025-03-26`, served directly over HTTP. A subsequent run exercised the exact
generated stdio proxy configuration from the npm registry, as described below.

The installer minted `honua-local-agent` with effective grants
`admin:read`, `admin:write`, and `read:*`. After replacing that credential with an
explicitly minted legacy two-grant key in the private installer files, a second
installer run reissued it with reason `legacy-grants` and revoked the legacy key.
A third run kept the replacement's identity and did not provision another key.
Exactly one active local-agent key remained; `.env` and both generated MCP
configuration files agreed on its material and retained mode `0600`.

Using the replacement key, `honua_list_layers` returned ten authenticated fixture
publications, and `honua_render_map` returned a successful 512 × 512 PNG.
The authenticated HTTP artifact download produced
[the rendered map](2026-10-11-render.png), with nine visible fixture points,
3,816 bytes, and SHA-256
`37a2da5d5324f0832f0819f1fbbad557435f0d0a1659a5924ca3f76eaa07c7d3`.
Raw MCP results, all three installer receipts, and the lifecycle assertions are
preserved in the JSON. Historical `/temp/` artifact references expire after one
hour; the PNG here preserves the downloaded bytes.

The generated `.mcp.json` was also executed exactly as written:
`npx -y --package @honua/mcp-server@0.1.14 honua-mcp-proxy`, under Node 20.19.0.
An MCP SDK stdio client initialized the proxy, discovered both tools, listed the
same ten fixture publications, and rendered the same image. Its authenticated
artifact download matched the archived PNG hash. The installed registry package
integrity matched the installer pin, and its resolved SDK peer identity is
recorded in `generatedProxy`. This verifies the generated client path as well as
the direct HTTP path; it does not compare the complete bounded catalogs.

## Procedure and scope

The run used an isolated quickstart Compose project at `127.0.0.1:19803`, with
`Development` configuration. Node 24.19.0 loaded the unmodified SDK TypeScript
source using a resolution hook for its emitted `.js` import names. The install
call used `{ directory, httpPort: 19803, timeoutMs: 180000 }`; the process runner
passed `HONUA_SERVER_IMAGE` with the immutable candidate reference to Docker.
Every HTTP request used the real server. No credential values are archived.

The canonical `test/integration/seed/places-roads-v1.sql` fixture was loaded into
only that project's database, with these explicit adaptations:

- Create `postgis_raster` in `public`, where the installer puts PostGIS.
- Set the fixture's `allowAnonymous` defaults to `false`.
- Enable the PNG GDAL driver after the initial raster render reported a missing
  output driver, using `ALTER SYSTEM SET postgis.gdal_enabled_drivers = 'PNG'`
  and `SELECT pg_reload_conf()`.
- Remove the single layer-zero row from `honua.raster_data` to exercise vector
  fallback. The seeded constant raster otherwise takes priority over the points.

For the lifecycle control, the root credential created a key named
`honua-local-agent` with exactly `admin:read` and `admin:write`, the initial key was
revoked, and the legacy material was persisted to `.env` and both MCP configs.
The real installer then ran twice. Assertions checked the reissue reason, legacy
revocation, replacement identity stability, active-key count, permissions, and
private file contents/modes. The final `McpClient` used only the replacement key.
Its render arguments were layer `0` of service `svc-test-service-feature`, bbox
`[-122.5, 37.7, -122.35, 37.84]`, SRID `4326`, and width/height `512`.

The legacy two-grant control also succeeded at listing and rendering on this
later candidate, which permits scoped admin reads. This run therefore does not
claim that the legacy key is denied data access; it proves the requested grant
set, real reissue lifecycle, and successful use of the new credential.

The supported customer image pin remains the older `87966c3` image shown in each
installer return value. The separate inspected image identity records the
explicit development override actually executed. These fixture preparations and
overrides do not qualify a clean customer install or advance the supported pin.
The returned image was fetched over HTTP; MCP `resources/read` returned
`Unknown resource` for it. Full catalog parity, style/resource behavior, and the broader release
qualification in issue 1401 remain separate.
