---
type: reference
title: Local setup development qualification for issue 1401
---

# Local setup development qualification — issue 1401

The [2026-10-11 receipt](2026-10-11-receipt.json) proves the corrected local installer policy and client contract boundaries on immutable development server `93cad86`. It is **not a release qualification pass**: the supported customer package/image pair has not advanced, and the rendered artifact cannot yet be read through MCP resources.

Both generated profiles use the canonical 2026.1 disabled-licensing policy and permit exactly the bundled database environment reference. A fresh isolated installation remained ready after server restart with the same scoped key; unauthenticated Admin access returned 401. The generated configuration then created a connection through `env:HONUA_LOCAL_DB_PASSWORD` and tested it healthy. An unlisted environment reference remained rejected with 400. No password was embedded in a connection request. Exact prior generated templates can be updated; custom settings still fail closed. Old Community installations whose keys existed only in memory need the documented fresh-directory path rather than automatic credential recovery.

The existing installer parcel was published and a fixture style created through canonical OGC Styles. Real MCP get/apply/read-back/render calls used numeric layer IDs and numeric style versions. Both source validators preserve the server's canonical `sha256:` metadata values; bare digests remain correct only for the independent manifest-file checksum.

Direct HTTP and the generated registry `@honua/mcp-server@0.1.14` stdio proxy returned the same 37 setup descriptors, schemas, annotations, output schemas and view metadata. The view advertises `geometry.buffer`. This capture exercises the bounded setup view, not the full Admin catalog.

The qualifier reached `resources/read` using the exact URI shared by the rendered image and `resource_link`. The server returned `-32002 Unknown MCP resource`; its advertised resource templates contain no rendered-artifact handler. An authenticated HTTP control fetched a valid PNG, but that does not satisfy the required MCP resource read. [Server issue 5867](https://github.com/honua-io/honua-server/issues/5867) tracks this dependency. The receipt retains the failed qualification and the deliberate image override explicitly.

Issue 1401 remains open for the clean released package/image pair, the complete canonical style/resource sequence, released guidance qualification, and consumption of exact-candidate receipts by the release gates.
