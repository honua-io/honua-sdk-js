---
type: guide
title: "MCP compatibility across the Node 22 transition"
description: "Managed publication order and bounded peer policy for the SDK minor-line bridge."
---
# MCP compatibility across the Node 22 transition

The generated installer pins a published MCP package. SDK publication proves
that its packed SDK installs beside that exact public MCP under npm's default
peer resolver. MCP publication independently proves that its packed MCP installs
beside the exact public SDK. Neither guard permits a workspace substitute or a
peer-resolution workaround.

A breaking pre-1.0 release advances the SDK from 0.1 to 0.2. An existing MCP peer
of `^0.1.17` excludes 0.2, so attempting that cut without a bridge would leave
each publisher waiting for the other. The Node 22 engine-floor change remains a
breaking change; it must not be disguised as a compatible patch.

`config/mcp-sdk-peer-policy.v1.json` declares the reviewed bridge
`^0.1.17 || ^0.2.0`. It admits stable releases on those two adjacent minor lines
and excludes earlier SDKs, prereleases, and 0.3+. Release Please continues to
manage package versions and development dependencies, but its workspace plugin
preserves this peer range. `verify:mcp-pin` and the unit suite refuse a changed
package/lockfile range, automatic peer replacement, or a source SDK outside the
policy. A future incompatible API change must review the policy before release.

The delivery order is:

1. Merge the compatibility bridge while retaining the current Node 20 baseline,
   then complete the normal managed current-line SDK/MCP patch release. Verify
   the real public artifacts and default-resolver installation.
2. Run canonical `sync:mcp-pin` against that published bridge. Record and verify
   its peer range from the actual integrity-verified tarball `package.json`,
   require agreement with the registry manifest, and retain the package JSON
   hash in `config/mcp-pinned-peer.v1.json`. The sync verifies all inputs before
   writing this receipt and either pin home. Offline verification binds the
   recorded peer to the exact pin and integrity; live verification downloads and
   checks those bytes again. An inferred caret based on the independently
   versioned MCP release cannot describe this bridge. Actual bridge publication
   and the synchronized pin remain pending until those bytes exist.
3. Merge the approved Node 22 breaking baseline and let Release Please compute
   the next minor versions. Preserve the public bridge pin until the next MCP
   artifact is actually published. The existing packed/public installation and
   release verification gates remain mandatory.

A range declaration proves metadata compatibility only. Source/runtime tests,
managed updater checks, and real default-resolver installations are separate
proofs. A future 0.2 package is not published or qualified by this policy change.
Historical Node 20 receipts and the certified scaffold fallback remain intact.
