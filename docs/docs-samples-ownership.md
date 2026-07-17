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

## Public route handoff

`npm run docs:site` consumes the v3 fixture, its three content-addressed inputs,
and the matrix-bound sample-kit manifest before it writes any public sample
route. The generated site exposes:

- `samples/index.html`: the four maintained kit journeys and their exact
  `source` / `packed` runner commands;
- `samples/<sample-id>.html`: one canonical page for every public recipe, lab,
  or qualified golden entry, preserving support, lifecycle, evidence,
  provenance, freshness, degradation, and replacement truth;
- `samples/routes.html`: the complete legacy route migration map;
- `samples/site-handoff.v1.json`: the versioned, digest-bound route manifest a
  presentation consumer can validate or proxy without copying executable
  source.

The current kit journeys are `maplibre-quickstart`, `migration-workbench`,
`service-explorer`, and `standalone-quickstart`. Run either mode from the SDK
repository root:

```bash
npm run samples:run -- verify --kit --sdk-mode source
npm run samples:run -- verify --kit --sdk-mode packed
```

SDK-owned public legacy routes redirect to the canonical sample page. Internal
fixtures and site-owned exceptions render an explicit status instead of a
substitute demo. Identical legacy aliases are grouped into one output path with
all route IDs; conflicts and collisions with generated site pages fail the
build before publication. A route page or successful kit run does not itself
qualify a golden journey—the receipt and visual-evidence gates remain
authoritative.
