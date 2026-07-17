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
[`honua-site-samples.v2.json`](../samples/dist/honua-site-samples.v2.json)
projection from a pinned SDK commit or published npm tarball. It must not infer
stability from `package.json` export presence. The v1 sample contract remains
available only as a frozen compatibility surface for consumers completing
their v2 migration.

## Versioned gallery handoff

The SDK also publishes
[`honua-site-consumer-handoff.v1.json`](../samples/dist/honua-site-consumer-handoff.v1.json).
It is the content-addressed consumer projection for the gallery rather than a
second application implementation. It joins the v2 presentation projection,
the generated capability-to-sample matrix, and current golden visual evidence;
then exposes canonical public cards, filter dimensions, visible coverage gaps,
legacy route dispositions, and lifecycle replacement or retirement notices.

Public detail routes are stable `samples/<sample-id>.html` paths. Existing
SDK-owned aliases use permanent redirects to those paths. Internal fixtures and
site-owned exceptions require explicit status pages and cannot be silently
redirected to unrelated samples. External listings use only the canonical
paths. Executable source remains in this repository and is represented only by
repository/path references in the handoff.

The generated
[`honua-site-consumer.v3.json`](../samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json)
fixture pins the handoff digest and expected task, capability, protocol,
keyboard, accessibility, and desktop/mobile behavior. These are requirements
for the presentation consumer. Publishing the SDK artifact does not by itself
prove that `honua-site` has adopted it: site CI must validate the fixture and
pass its static build plus browser accessibility/responsive smoke before the
cross-repository rollout is complete.
