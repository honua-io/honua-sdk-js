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

The completed Node 20-to-22 transition followed this delivery order. These are
historical steps; use the current published-pin guidance below for new releases.

1. The compatibility bridge merged while retaining the Node 20 baseline,
   followed by the normal managed current-line SDK/MCP patch release and
   verification of its real public artifacts and default-resolver installation.
2. Canonical `sync:mcp-pin` recorded the published bridge's peer range from its
   integrity-verified tarball `package.json`, checked agreement with the registry
   manifest, and retained the package JSON hash in
   `config/mcp-pinned-peer.v1.json`. The sync verifies all inputs before
   writing this receipt and either pin home. Offline verification binds the
   recorded peer to the exact pin and integrity; live verification downloads and
   checks those bytes again. An inferred caret based on the independently
   versioned MCP release cannot describe this bridge. The historical Node 20 bridge used published
   `@honua/mcp-server@0.1.19`. Keep its immutable receipts as transition
   evidence; it is no longer the current generated-client pin.
3. The approved Node 22 breaking baseline merged, and Release Please computed
   the next minor versions. The public bridge pin was retained until the next
   MCP artifact was published. The existing packed/public installation and
   release verification gates remain mandatory for subsequent releases.

A range declaration proves metadata compatibility only. Source/runtime tests,
managed updater checks, and real default-resolver installations are separate
proofs. This policy change alone did not publish or qualify the subsequent 0.2 packages.
Historical Node 20 receipts and the certified scaffold fallback remain intact.

## Historical bridge recovery and release boundary

SDK 0.1.18 was sealed from the reviewed Node 20 source
`7768fa900a9d02c2045d15a116cfcb8fab6fdd95`. MCP 0.1.19 was published from
`ae6a835b5334a14c380b085d1af57161243ae0d5`. Their immutable releases and public
artifacts preserve that supported Node 20 bridge. The MCP publisher passed a
real default-resolution install beside public SDK 0.1.18 before publication.

At the recovery checkpoint, trunk required Node 22.12 or newer for both SDK
and MCP, while the recovered SDK tag belonged to an earlier reviewed branch.
The managed release history scan had not carried the original engine-floor
declaration into both components' next version calculation. The forward
history therefore had to declare the same breaking boundary: the Node 22
transition required SDK **0.2.0** and MCP **0.2.0** through Release Please,
rather than a 0.1 patch. That release-boundary requirement is historical; no
version override or manual tag is permitted.

The independent public-byte receipts are retained under
`docs/evidence/mcp-bridge-2070/`. They prove the historical Node 20 artifact identities; they do not describe
the current synchronized pin.

## Current published pin

The current generated-client pin is published `@honua/mcp-server@0.2.4`.
`config/mcp-pinned-peer.v1.json`, `src/local-install.ts`, and all three shipped
zero-to-map client configurations identify that release and its verified
registry integrity. Its SDK peer range remains `^0.1.17 || ^0.2.0`.

Public SDK 0.2.4 and MCP 0.2.4 have passed a real co-install under npm's
default peer resolver. Keep using `sync:mcp-pin` after a coordinated MCP
publication and run `verify:mcp-pin` and `verify:client-pair:registry` against
the resulting pin. Generated CLI changes reach consumers through the normal
next SDK release. Package co-installation does not qualify the complete
Docker-to-map workflow; that still needs the installed integration journey.
