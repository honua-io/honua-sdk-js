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

The trusted Release Please refresh also derives the new MCP workspace dependency
notes from the actual base and candidate package declarations. The upstream
workspace plugin can propose peer or local development dependency bumps in its
notes even when its package updater preserves those declarations. The refresh
checks the candidate lockfile and peer policy, corrects only the newest MCP
changelog entry and matching PR body, and sends the resulting exact head through
normal CI. It leaves historical release notes and other dependencies unchanged;
versions and changelogs are never corrected by hand.

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
   versioned MCP release cannot describe this bridge. The current bridge is the published `@honua/mcp-server@0.1.19`; the
   synchronized pin and receipt identify its verified public bytes.
3. Merge the approved Node 22 breaking baseline and let Release Please compute
   the next minor versions. Preserve the public bridge pin until the next MCP
   artifact is actually published. The existing packed/public installation and
   release verification gates remain mandatory.

A range declaration proves metadata compatibility only. Source/runtime tests,
managed updater checks, and real default-resolver installations are separate
proofs. A future 0.2 package is not published or qualified by this policy change.
Historical Node 20 receipts and the certified scaffold fallback remain intact.

## Recovered bridge and the next release boundary

SDK 0.1.18 was sealed from the reviewed Node 20 source
`7768fa900a9d02c2045d15a116cfcb8fab6fdd95`. MCP 0.1.19 was published from
`ae6a835b5334a14c380b085d1af57161243ae0d5`. Their immutable releases and public
artifacts preserve that supported Node 20 bridge. The MCP publisher passed a
real default-resolution install beside public SDK 0.1.18 before publication.

Current trunk already requires Node 22.12 or newer for both SDK and MCP. The
recovered SDK tag is on an earlier reviewed branch, and the managed release
history scan did not carry the original engine-floor declaration into both
components' next version calculation. The pin change therefore declares the
same breaking boundary in the forward SDK and MCP history: Node 20 is
unsupported in the next release. Release Please must compute SDK **0.2.0** and
MCP **0.2.0** through the normal managed workflow. A proposed 0.1 patch containing
that engine change remains unpublishable; no version override or manual tag is
permitted.

The independent public-byte receipts are retained under
`docs/evidence/mcp-bridge-2070/`. They prove the current-line artifact identities,
not the future minor pair. Its actual default-resolution publication and public
registry verification remain required before the transition is complete.
