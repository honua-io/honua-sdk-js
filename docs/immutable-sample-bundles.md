# Immutable content-addressed sample bundles

The `Publish content-addressed sample bundles` workflow creates independently verifiable producer
evidence for one exact SDK `trunk` commit. It is manually dispatched and accepts no source or release
inputs. Before building, it requires `GITHUB_REF` to be `refs/heads/trunk` and `GITHUB_SHA` to equal
the repository API's current `trunk` SHA. It repeats that API gate immediately before attestation or
publication.

## Owner prerequisite

An organization owner must enable immutable releases for `honua-io/honua-sdk-js` and enforce the
setting at the owner level before the first dispatch. This is an external administrative prerequisite,
not something the publisher enables. The workflow queries the immutable-releases API before using
its write token and after publication, and fails unless both `enabled` and `enforced_by_owner` are
true. Do not dispatch while either value is false.

## Build and trust boundaries

The read-only build job checks out the exact SHA into three clean, credentialless trees: one governed
workflow/tooling tree and two independent producer trees. It uses Node `20.19.0` and `npm ci`, runs
the canonical bundle build and verification in both producer trees, and byte-compares both manifests,
archives, and pack metadata. The packer snapshots each verified file once, sorts POSIX ustar paths
using explicit UTF-8 byte order, uses the source commit timestamp, uid/gid zero, normalized
`0644`/`0755` modes, and emits a gzip
stream with no name or timestamp and a specified sequence of maximum-size stored DEFLATE blocks.

The build job runs bounded producer browser smoke, canonicalizes visible-text whitespace, validates its exact recursive schema/source/result set, and
creates two receipts. The deterministic receipt is a release asset. It binds the source, lockfile,
runtime, workflow and action identities, normalized smoke evidence, file count, asset sizes and
SHA-256 digests, and two-build byte equality. The per-run receipt carries run ID/attempt, hosted runner
image/version/OS/architecture, and the raw smoke-receipt digest; it is attested but not released.

The privileged job has no checkout and executes no repository or build-controlled program. A pinned
download action transfers only six governed files: five duplicate-key-rejecting JSON documents plus
the archive, including raw browser-smoke and pack metadata that are not published. Reviewed inline steps validate the exact file set, types, recursive smoke and receipt
schemas, identities, sizes, SHA-256 digests, manifest/archive membership, canonical tar/gzip bytes, and
native tar readability before exposing a token. GitHub CLI `2.93.0` is downloaded and accepted only
at its pinned Linux amd64 archive digest.

## Publication and verification

The only publication target is `sample-bundles-<full-source-SHA>`. The workflow uses a global
concurrency lock, never clobbers assets, never changes the rolling sample-bundle release, and creates
the tag against the exact source SHA with `--latest=false`. Existing state is accepted only when the
tag target, complete asset set, and every asset byte exactly match; partial, divergent, or colliding
state fails closed.

GitHub OIDC attests the three immutable release assets on creation and attests every run receipt.
After both creation and exact-idempotent paths, the publisher redownloads and byte-compares each
release asset. It then runs `gh attestation verify` for every release asset and the run receipt while
requiring the exact repository, signer workflow and digest, `refs/heads/trunk`, source digest, SLSA
provenance predicate, and a GitHub-hosted runner.

## Dispatch sequence

1. Merge the independently reviewed publisher before the Release Please PR.
2. Refresh the Release Please PR on the resulting `trunk`.
3. Merge the final release PR.
4. Confirm owner-enforced immutable releases remain enabled.
5. Dispatch the publisher exactly once from that exact current `trunk` SHA.
6. Verify the release assets and attestations before making consumers bind the exact object.

## Fail-closed publisher guarantees

The publisher is input-free and accepts only a manual dispatch of the exact current
`refs/heads/trunk` commit. It builds in two credentialless clean checkouts, compares
the manifest, canonical gzip/ustar archive, and pack metadata byte-for-byte, and
records the governed Node, lockfile, workflow, runner, action, browser-smoke, and
source identities. The released receipt is deterministic; run ID, attempt, runner
image, and other per-run fields remain only in the separately attested run receipt.

The privileged job checks six regular artifact files before any API or OIDC-bearing
step. Its inline validator recursively rejects duplicate keys while independently parsing
the manifest, receipts, pack metadata, raw smoke proof, gzip stream, and every ustar header
and member byte. It reconstructs the exact
ustar headers, padding, order, end blocks, and deterministic gzip stream and requires
byte equality. Absolute/traversing/control-character paths,
links, devices, FIFOs, PAX/GNU extensions, duplicates, reordering, metadata drift,
and manifest digest mismatches fail closed. All actions resolve to exact verified
commit objects; provenance uses
`actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a`.

Immediately before release creation the workflow repeats the exact-ref and current
trunk API gate. It also requires repository immutable releases to be both enabled
and owner-enforced. Existing content-addressed releases are accepted only when the
tag target, immutable state, asset set, sizes, and bytes are exact. The publisher
never reads or modifies `sample-bundles-latest` and never overwrites an asset.

## The rolling release is retired, not merely untouched

This document originally read the sentence above as a coexistence guarantee: the
content-addressed publisher would leave the rolling `sample-bundles-latest`
release alone and the two would run side by side. That assumption did not
survive contact with the org-level setting it depends on.

Immutable releases were enabled org-wide on 2026-08-13 and applied
**retroactively**, permanently freezing `sample-bundles-latest` (release id
`356226688`, created 2026-07-19) at its 2026-08-13T10:32Z assets. The rolling
job in `ci.yml` kept trying to move it and failed identically every run with
`HTTP 422: target_commitish cannot be changed when release is immutable`, which
is what held `SDK CI` red on trunk for 15 consecutive runs
(honua-io/honua-sdk-js#1325). The rolling pattern is structurally incompatible
with immutable releases -- the release and its tag can no longer be updated
*or* deleted -- so the job was removed rather than repaired
(honua-io/honua-sdk-js#1320).

Two consequences a reader of this page needs:

- **`sample-bundles-latest` is retired.** It is not a stale-but-refreshing
  pointer; it is a permanent snapshot of one 2026-08-13 build and will never
  advance. Its release notes additionally misstate their own provenance --
  they name commit `6a5330899` while the frozen assets were built from
  `9c88f65b8`, because the notes edit landed before the assets froze. Notes
  remain editable and correcting them needs a repo admin.
- **Consumers must resolve bundles by source commit.** The only supported
  pointer is the per-commit tag `sample-bundles-<full-source-SHA>` described
  above. The site projection carries it as a template rather than a fixed tag
  (`sampleBundles.publication.releaseTagTemplate` =
  `sample-bundles-{sourceCommit}`); substitute the full 40-character SHA of the
  source commit whose bundles you want. See
  [sample-bundles.md](./sample-bundles.md) for the consumer walkthrough.

The publisher's own policy assertion still holds and is now the stronger
statement: it never reads or modifies the retired rolling release, and
`scripts/immutable-sample-bundle-attestation.mjs` fails closed if the workflow
ever references `sample-bundles-latest` again.
