# Bounded setup catalog qualification

The 2026.1 setup gate uses the candidate's server-authored workflow view. It
does not require the legacy full Admin, analysis and Esri GP roster. Run the
catalog check from an installed, integrity-verified MCP package:

```sh
node node_modules/@honua/mcp-server/dist/src/certification/setup-parity.js \
  reviewed-server-manifest.json <independently-pinned-manifest-sha256> \
  setup-catalog-receipt.json
```

From source, the equivalent command is `npm run certify:setup-parity -- ...`
in `mcp/`. Configure `HONUA_MCP_REMOTE_URL` and exactly one credential source:
`HONUA_MCP_AUTH_TOKEN`, `HONUA_ADMIN_KEY`, or `HONUA_API_KEY`. Credentials must
not appear in arguments, URLs, the manifest or receipts. The existing proxy
enforces HTTPS for credential-bearing endpoints, with the local loopback
exception used by the Docker installer.

The manifest is a reviewed capture from the pinned server under the intended
effective permissions. Keep its SHA-256 in the release lock/evidence index,
separate from the captured file. It has this structure:

```json
{
  "schemaVersion": "honua.setup-catalog-manifest/v1",
  "candidateId": "manifest-sha256:<release-manifest-digest>",
  "serverImage": "ghcr.io/honua-io/honua-server@sha256:<image-digest>",
  "packages": [
    { "name": "@honua/sdk-js", "version": "<exact-version>", "integrity": "sha512-<registry-integrity>" },
    { "name": "@honua/mcp-server", "version": "<exact-version>", "integrity": "sha512-<registry-integrity>" }
  ],
  "serverInfo": { "name": "<initialize serverInfo.name>", "version": "<initialize serverInfo.version>" },
  "view": "<server-published bounded view>",
  "revision": "<tools/list _meta.revision>",
  "revisionDigest": "<tools/list _meta.revisionDigest>",
  "membershipDigest": "<tools/list _meta.membershipDigest>",
  "descriptorDigest": "<tools/list _meta.descriptorDigest>",
  "tools": ["<complete original tool objects from all pages, not names or abbreviated schemas>"]
}
```

The placeholders above illustrate the shape and are deliberately invalid as
qualification input. Discover the view from the server's capabilities; do not
invent profile switches or assemble a replacement tool roster in the client.
Retain complete descriptions, input/output schemas, annotations and `_meta`.
The server's opaque digests are compared to the reviewed pin. The receipt also
computes independent normalized descriptor hashes for HTTP and stdio; these
use a different serialization from the server and have distinct field names.

The check drains all pages over direct HTTP and a real child-process stdio
proxy, carrying the selected view on every page. It fails on missing, extra,
duplicate or changed tools, missing/changed revision metadata, server identity
drift, cursor loops and proxy differences. Missing tools identify candidate
view/effective permissions as the diagnostic boundary. No total such as 441 is
used to decide success, and a complete but short catalog is a membership
failure rather than a guessed pagination fault.

The receipt's scope is `catalog-parity-only`. Its candidate image and package
integrities are **bindings from the reviewed manifest**, not a claim that this
command inspected the running image or verified installed package bytes.
The release producer must verify those bindings against its immutable install
receipt before consuming this result. This read-only check does not install a
server, mutate styles, prove `geometry.buffer` execution, validate effective
permissions, or satisfy all of #1401. Retain the separate clean-install,
readiness/auth, bounded task execution, get-style → apply-style-preset →
render-map → read-resource PNG, and versioned-guidance receipts for
honua-release#123/#129/#161. Existing `assertRenderedPng` checks reject empty
or flat renders; a catalog match alone cannot establish style success.

The older zero-to-map runner retains its broader workflow as an explicit
legacy integration exercise. It must not be used as the 2026.1 bounded catalog
gate, or its full Admin/analysis prerequisites would reintroduce deferred
scope into first-cut qualification.
