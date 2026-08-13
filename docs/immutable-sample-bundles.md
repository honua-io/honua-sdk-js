# Immutable content-addressed sample bundles

The `Publish content-addressed sample bundles` workflow creates independently verifiable producer
evidence for one exact SDK `trunk` commit. It is manually dispatched and accepts no source or release
inputs. Before building, it requires `GITHUB_REF` to be `refs/heads/trunk` and `GITHUB_SHA` to
equal the repository API's current `trunk` SHA.

The workflow checks out that exact SHA twice into clean trees, uses Node `20.19.0` and `npm ci`,
runs the canonical sample bundle build and verification in both trees, and byte-compares the
manifests and archives. The canonical packer uses sorted POSIX ustar
paths, the source commit timestamp, uid/gid zero, normalized `0644`/`0755` modes, and a gzip header
with no name or timestamp.

After producer browser smoke passes, the workflow emits and GitHub-attests a receipt binding the
source and lockfile, workflow identity, runtime, file count, smoke receipt, asset sizes and SHA-256
digests, and both byte comparisons. Its only publication target is the immutable tag, release, and
workflow artifact `sample-bundles-<full-source-SHA>`. Existing publication
state is accepted only when the tag resolves to the exact source commit and all three release assets
are byte-identical. Partial or different state fails closed. The workflow does not modify the rolling
sample-bundle release.

Dispatch the workflow once from the current `trunk` commit after the commit has received independent
review. Consumers must verify the release tag, GitHub provenance attestation, and asset digests
before accepting the archive.
