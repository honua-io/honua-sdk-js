# Documentation and samples ownership

The SDK repository is canonical for executable sample source, public API
compatibility, build/test evidence, and the machine-readable entrypoint
inventory in [`config/public-surface.json`](../config/public-surface.json).
Changes to an SDK example or public surface land and pass compatibility gates
here before they are projected elsewhere.

The [`honua-site`](https://github.com/honua-io/honua-site) repository owns the
public, versioned samples/documentation catalog on `honua.io` and deployment of
its browser artifacts. Site samples consume the deployed Honua demo server and
approved AWS-hosted live datasets; the site does not become a second source
tree for SDK examples.

The canonical v2 sample contract is owned by
[`honua-sdk-js#540`](https://github.com/honua-io/honua-sdk-js/issues/540). It
inventories every runnable root and docs example, separates learning track from
support tier and lifecycle, reserves seven golden journey IDs, and generates
both CI selection and presentation-safe site metadata. The showcase consumer
work is tracked by
[`honua-sdk-js#550`](https://github.com/honua-io/honua-sdk-js/issues/550).

Downstream tooling consumes the generated
[`honua-site-samples.v3.json`](../samples/dist/honua-site-samples.v3.json)
projection from a pinned SDK commit or published npm tarball. The frozen v2
projection remains available for existing consumers. Tooling must not infer
stability from `package.json` export presence. The v1 sample contract remains
available only as a frozen compatibility surface for consumers completing
their v2 migration.

## Versioned gallery handoff

The SDK also publishes
[`honua-site-consumer-handoff.v2.json`](../samples/dist/honua-site-consumer-handoff.v2.json).
It is the content-addressed consumer projection for the gallery rather than a
second application implementation. It joins the v3 presentation projection,
the generated capability-to-sample matrix, and current golden visual evidence;
then exposes canonical public cards, filter dimensions, visible coverage gaps,
legacy route dispositions, and lifecycle replacement or retirement notices.

Public detail routes are stable `samples/<sample-id>.html` paths. Existing
SDK-owned aliases use permanent redirects to those paths. Internal fixtures and
site-owned exceptions require explicit status pages and cannot be silently
redirected to unrelated samples. Retired and replacement cards keep canonical
lifecycle-status pages so their reason and replacement remain visible. External
listings use only the canonical paths. Executable source remains in this
repository and is represented only by canonical, non-symlink repository/path
references in the handoff.

Publication is fail-closed and reproducible from the handed-off bundle alone.
The handoff's declared `policy.qualifiedRequires` is machine-checked per
qualified card against that card's own embedded evidence — bound source
identity, packed-mode `packed-build`, `fixture` and `live` receipts, both the
desktop and mobile reproducible captures, and all nine semantic gate receipts in
canonical order — and every aggregate, per-gate, and live freshness window is
re-evaluated against the validation clock, so an expired receipt fails
publication instead of shipping a stale card. No two cards may share a canonical
route, an executable source path, a golden journey, an evidence binding, or a
visual evidence sample, and the upstream projection, matrix, and visual-evidence
inventories may not repeat those identities either. Every screenshot, repeat
capture, gate receipt, and gate report a card advertises must resolve inside the
owning sample's own evidence root and evidence run as a regular non-symlink file
whose bytes and digest match the published reference. Each reference also
content-addresses the schema that governs it — `schemaBytes` and `schemaSha256`
alongside the artifact's own `bytes` and `sha256` — and validation recomputes
that digest from the schema on disk, so a schema edited in place while keeping
its `$id` and version fails publication rather than handing consumers an
unversioned bundle. Honestly pending coverage still publishes: a `planned`, `partial`,
`experimental`, or `unsupported` card carries no evidence binding and no visual
evidence, and only overstated claims fail. See
[`samples/contract/v2/README.md`](../samples/contract/v2/README.md) for the full
admission contract.

The generated
[`honua-site-consumer.v4.json`](../samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json)
fixture pins the handoff digest and expected task, capability, protocol,
keyboard, accessibility, and desktop/mobile behavior. These are requirements
for the presentation consumer. Contract-declared card, route, gap, facet,
filter, JSON-depth, and artifact-byte budgets fail closed before adoption.
Publishing the SDK artifact does not by itself
prove that `honua-site` has adopted it: site CI must validate the fixture and
pass its static build plus browser accessibility/responsive smoke before the
cross-repository rollout is complete.
