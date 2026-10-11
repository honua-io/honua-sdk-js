---
type: guide
title: "Zero-to-map release journey"
description: "The bounded 2026.1 install, configure, process, compose, and separately approved 2D map journey."
---
# Zero-to-map release journey

The 2026.1 cut qualifies a bounded setup → configure → published 2D map journey.
Its acceptance definition and deterministic driver are owned by
[honua-release#123](https://github.com/honua-io/honua-release/issues/123) and
[the terminal journey](https://github.com/honua-io/honua-release/tree/trunk/certification/terminal-journey).
Record the exact release-driver commit used; a moving branch URL is guidance,
not an immutable evidence pin.

## Current bounded path

1. Install the manifest-pinned published SDK/MCP pair under default npm peer
   resolution and the immutable server image. Retain package integrities,
   source commits, image digest, readiness, authentication, and effective grants.
2. Compare the server-authored bounded workflow view over HTTP and the installed
   stdio proxy against the independently reviewed catalog manifest. Compare
   every descriptor, schema, annotation, and output contract. Neither a guessed
   profile nor a fixed tool count proves parity. Use
   [setup parity certification](../mcp/certification/setup-parity.md) and
   `honua admin qualify`; preserve failures when a required operation is absent.
3. Configure the supported datasource, import the bounded fixture, poll its real
   job, and publish the resulting layer with the intended access policy. Join
   job, source, layer, operation, and audit identities; preserve schema, geometry,
   CRS, row, and failure evidence, not just an accepted HTTP response.
4. Discover and execute the existing `geometry.buffer` process using its actual
   input schema and a bounded geometry. For the advertised GPServer WKB path,
   provide `wkb`, `srid`, and `distance`; EPSG:4326 distance is in degrees. A
   `layerId` is not a geometry input. Retain the terminal job and result identity.
   See [geoprocessing guidance](../skills/honua-geoprocessing/SKILL.md).
5. Prove the published layer's style through get-style → apply-preset → read-back
   → render → MCP `resources/read`. Verify style identity and nonempty rendered
   pixels, not merely PNG byte length. `honua admin qualify` joins the catalog
   receipt and this style proof to the local install.
6. Compose one 2D map with the imported layer, style, view, and basic controls.
   Validate, save an immutable version, read it back, reopen it, and prove the
   same content survives restart and a distinct replica read. Retain item,
   version, and content hash. See
   [map composition](../skills/honua-map-composition/SKILL.md).
7. Propose publication of that exact saved version under the supported proposer
   policy. Require a durable pending proposal and refusal of proposer
   self-approval without mutation. An immediate admin publication does not
   establish this approval boundary.
8. A separate human approver reviews the proposal and uses the typed CLI with
   their own authenticated profile. Approval takes no request body:

   ```bash
   honua admin operate approveOperationProposal --path id=<proposal-id> --profile approver --yes
   honua admin operate getOperationProposal --path id=<proposal-id> --profile approver --json
   ```

   `--yes` is CLI mutation consent, not proof of human identity. Poll the actual
   proposal to terminal success, retain server-issued approval and audit joins,
   and read the authorized final map. Compare its item, version, hash, and body
   with the saved map. A share URL returning HTTP 200 alone is insufficient.
   Until the human acts, retain `AwaitingApproval`; do not invent a completed run.

Full Admin MCP exposure, additional analysis families, `analytics.buffer-aggregate`,
`analysis`/`esri-gp` profile switches, dashboards, and a 441-tool count are not
requirements for this bounded cut. Missing required support is a blocker to
report, not permission to substitute a broader workflow.

## Versioned guidance and receipt consumers

Use the [task skills](../skills/README.md) and local docs from the exact reviewed
SDK source commit associated with the candidate; retain that commit and the
corpus digest alongside package versions. The npm packages do not currently
ship the complete repository skills/docs corpus. A registry-installed docs
search tool may therefore return `available: false`. Supply the matching
versioned source documentation separately; do not silently search a newer
checkout or describe an unavailable local corpus as successful retrieval.

The setup/style qualification receipt is one input to the full journey. It does
not certify import fidelity, restart durability, human approval, or model use.
Retain a redacted evidence URI and content digest with the exact candidate tuple,
client integrities, server digest, tool-view revision, and rendered artifact.
The release-owned consumers have distinct responsibilities:

- [Release#123](https://github.com/honua-io/honua-release/issues/123) joins that
  receipt to the deterministic eight-stage live journey and its durable IDs.
- [Release#129](https://github.com/honua-io/honua-release/issues/129) reuses the
  same journey on the verified AWS target and adds provisioning, handoff, and
  authorized cleanup receipts. A local run does not prove the AWS wrapper.
- [Release#161](https://github.com/honua-io/honua-release/issues/161) records the
  genuine model-driven canary with reviewed skills/docs, ambiguity handling,
  recoverable-error behavior, and separate human approval. A deterministic
  driver is not evidence of model calls or human actions.

None of these receipts advances a certified manifest or proves a published
candidate while it uses source builds, hand-repinned images, or unpublished
clients. Keep such engineering evidence explicit and replay the immutable pair
once the release artifacts and reviewed manifests are available.

## Retained repository integration bundle

[`mcp/release/zero-to-map`](../mcp/release/zero-to-map/README.md) retains a broader
engineering driver. It exercises an older map/app/dashboard workflow,
`analytics.buffer-aggregate`, a separate GPServer buffer proof, and immediate
admin share URLs. Its checked-in contract fixtures and simulated tests are not
a recording of the current bounded candidate or separate-human approval.

Contract mode validates that legacy plan, records live execution as blocked,
and never starts Docker. Its explicit live mode (`--execute --yes`) may still
be used for that broader engineering contract. Preserve its actual outputs and
limitations; do not relabel them as satisfying the current release journey.
