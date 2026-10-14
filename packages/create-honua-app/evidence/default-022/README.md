# Published default scaffold evidence

This directory retains the actual public `create-honua-app@latest` default-selection
journey at the independent `create-honua-app-v0.2.2` release. The SDK and scaffold
have different source commits: SDK `js-sdk-v0.2.2` is
`076b4218f832725d57a8e23745fae75aeb9f4e5a`; scaffold
`create-honua-app-v0.2.2` is `bd178cf762574379c8c0cfe6e923fe9a39ce9832`.
The canonical all-eight publication receipt retains the third, independent MCP
source identity as well.

The reviewed harness first observes public `create-honua-app@latest`, verifies its
version/source/tarball integrity, installs those exact published CLI bytes in a
fresh consumer, and checks the executable binding. It invokes that CLI with no
`--sdk-version` argument. Each generated app uses a fresh npm cache, public
registry, empty user/global npm configuration and default peer resolution, then
builds and serves the production bundle and drives the actual browser. The clock
includes public metadata resolution, CLI installation, scaffolding, app installation,
build, preview startup and rendered-map verification; its limit remains 120 seconds.
The map uses the starter's owned same-origin fixture, so this evidence does not
qualify a live server candidate.

Each template retains its unmodified raw receipt, execution configuration,
generated package, both installed lockfiles, observed latest metadata and actual
CLI selection output. `published-default-proof.mjs.raw` is the exact reviewed and
executed harness. Receipt hashes also bind the source browser and registry helpers
to the immutable scaffold producer. `documentation-provenance.json.raw` verifies that
the README in the downloaded public scaffold tarball is byte-identical to that
scaffold's own source, independently of the SDK release.

The recorded absolute paths describe the original execution. To reproduce, use a
clean checkout of the producer tag, install its locked dependencies under Node
22.23.3, and supply a new config pointing at these authenticated publication bytes
and a new output directory. Verify retained inputs against `files.sha256.json`. Copy `published-default-proof.mjs.raw`
to `published-default-proof.mjs` without changing its bytes and verify its SHA-256 remains
`076d13877b9e55c4a169bd59064c4daaa26d485e612dbebcb23035e24dfc7ab9`.
Run that harness under the shared build lock
with an outer 480-second timeout. The harness deliberately refuses a changed
public `latest` identity. Runtime provenance under `runtime/` records the real
Chromium binaries and legitimate Ubuntu packages used for missing browser shared
libraries; no custom browser bypass flags were supplied.

`lock-waits.json.raw` and both `published-default-*-attempt1.log` files preserve initial semaphore
waits that exited 75. The harness never executed during those waits, and its
120-second measurement had not begun. It is not a failed or successful map measurement.

The original issue's required SDK 0.2.1 explicit-template proofs remain unchanged
in [sdk-021](../sdk-021/explicit-template-proof.json), landed in PR2105 after their
actual runs. The later SDK 0.2.2 explicit proofs remain in
[sdk-022](../sdk-022/explicit-template-proof.json), followed by the certified
fallback change in PR2110 and the independent managed scaffold cut in PR2111.

Raw JSON and the executed harness carry an archival `.raw` suffix so their original
producer formatting and hashes remain intact. They are evidence inputs, not maintained
package code. Parse JSON receipts directly as UTF-8; the original filenames are retained
in each receipt. Authored `summary.json` and `files.sha256.json` use normal repository
formatting and checks. No formatter or lint policy is disabled.
