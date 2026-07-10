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

The projection boundary is tracked by
[`honua-site#120`](https://github.com/honua-io/honua-site/issues/120). The
versioned manifest, browser artifact, and validation-evidence contract that lets
the site consume SDK outputs without copying source is tracked by
[`honua-sdk-js#401`](https://github.com/honua-io/honua-sdk-js/issues/401) under
the samples/docs modernization epic
[`#398`](https://github.com/honua-io/honua-sdk-js/issues/398).

Until that contract lands, downstream tooling may read
`config/public-surface.json` from a pinned SDK commit or published npm tarball.
It must not infer stability from `package.json` export presence: deprecated
compatibility shims are intentionally exported during `0.1.x`, but are not
semver-protected API.
