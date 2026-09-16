# Studio candidate replay for honua-sdk-js#1397

`studio-candidate-replay.json` is the retained receipt of
`scripts/qualify-studio-candidate.mjs`. It replays all seven acceptance criteria of
issue 1397 in a single run: AC1–AC6 against the newest imaged honua-server candidate,
and AC7 against browser Studio built from honua-studio `main`.

The receipt's status is `failed`, and the only failing acceptance check is AC7. AC1–AC6
all pass with no deployment deviations. AC7 fails because browser Studio does not compile
against the SDK this run qualifies, and it does not dispatch through that SDK. The owner
is honua-io/honua-studio#71.

## What ran

- **Candidate:** `ghcr.io/honua-io/honua-server@sha256:069f196bfa5c7201223d4d89868934242c4ace8805a6e48c122a88d84fa6eb1a`
  (`nightly-87966c3`), image revision `87966c3f7b6c840ffc4d4da0b451714ab717b18a`,
  dbSchema 120. The running image id was checked against the digest, and its revision
  label against the manifest candidate ref.
- **Manifest:** the honua-release re-pin to this sha is still pending; the release is
  pinned at `8862065` by honua-release#354. The manifest the harness read is
  honua-release trunk's `platform-manifest.yaml` with exactly three lines changed:
  `candidate.ref`, the honua-server `sha` and its `digest`. Its sha256 is `cf5623ca…`.
- **Previous release:** `sha256:dd50cd81…` (revision `7ba4226`), booted only for the
  release-swap check.
- **Studio:** honua-io/honua-studio `main` at
  `5103fceb2ef7b74faf47ea6650e40278f739ca02`. That commit descends from `685ac57`
  (honua-studio#69, which deleted the local tool list). The harness archives the
  commit, not a working tree.
- **Deployment:** Production startup policy, fresh PostGIS and Redis, an OIDC resource
  server with a per-run HS256 key, a per-run operation key-ring certificate, and an
  Ed25519 transcript-signing key for the Studio AI proxy.
- **SDK:** built from this branch. The receipt's `sdkSourceSha` is the branch
  checkpoint `1c532761` the run was made from, retained on the branch's `wip/` backup
  ref. The only files that differ between that checkpoint and this PR's head are the two
  receipt files.
- **Principals:**
  - an admin API key
  - interactive end users `alice` (owner) and `bob` (other owner), both holding
    StudioDraft `*`
  - `carol`, with no grants
  - `dan`, with StudioDraft Discover/Read/Create/Update/Execute but no Publish
  - `alice` again under a read-only scope
- **The only double:** the model behind the proxy,
  `scripts/studio-candidate-model-stub.mjs`. It records the exact upstream request a
  provider receives and plays a fixed tool plan. Nothing here certifies a live model or
  an installed client.

**No deployment deviations.** Every candidate check ran under the image's own
configuration: the default prompt budget, and token replay protection on. The receipt's
`deploymentDeviations` is empty and `candidate.running.extraEnv` is `{}`.

Between `8862065` and `87966c3`, the Studio MCP tools gained a tenant boundary
(honua-server#4905). `McpWorkflowViewCatalog` and the descriptor classifier are
unchanged, so the transcribed `setup.v2` membership carries over.

The candidate binds a bearer to the surface it is first admitted on (#4899) and, on
`/mcp`, to the session it opens (#4909). The harness therefore holds one access token for
the HTTP API and one per MCP session, and it records that binding as a contract check:

| Attempt | Result |
| --- | --- |
| IdP-issued token opens an MCP session | Opened |
| Same token opens a second MCP session | 401 `unauthenticated`, `requiresReauthentication: true` |
| Newly issued token opens the second session | Opened |
| Held token, second request on its own session | 200, 25 descriptors |
| Token refreshed with identical authority, same session | 200, 25 descriptors |

## Acceptance criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| AC1 | Server-authored classification routed with no consumer allowlist | Pass | See [AC1](#ac1-evidence) |
| AC2 | `annotations` and `outputSchema` reach the model | Pass | See [AC2](#ac2-evidence) |
| AC3 | `tools/list_changed` over a real push channel refreshes without a reconnect | Pass | See [AC3 and AC5](#ac3-and-ac5-evidence) |
| AC4 | Terminal session executes mutate, validate, save/get/reopen, propose/poll | Pass | See [AC4](#ac4-evidence) |
| AC5 | Adding or removing a server Studio member changes the discovered set | Pass | See [AC3 and AC5](#ac3-and-ac5-evidence) |
| AC6 | A principal cannot invoke beyond server authorization | Pass, undeviated | See [AC6](#ac6-evidence) |
| AC7 | Browser Studio compiles against SDK discovery after deleting its local list | **Fail**: honua-io/honua-studio#71 | See [AC7](#ac7-evidence) |

### AC1 evidence

- Default `createStudioAgentSession` negotiated `setup` at initialize, as the admin key
  and as an end-user bearer, with no consumer-configured allowlist.
- It routed exactly the eight members transcribed from honua-server source at
  `87966c3` (`setup.v2`, family `honua.studio.composition`, view `setup`).
- It refused the other 17 setup-view descriptors, then routed the same eight after
  reconnect (a new MCP session on a newly issued token).
- The full catalog (124 descriptors) classifies the same eight.

### AC2 evidence

- On all 8 provider rounds, every routed tool reached the provider with its input schema
  unchanged.
- Its annotations and output schema were present verbatim in the provider description:
  8 of 8 tools carry both.
- No provider request contained a tool result without its assistant tool call.

### AC3 and AC5 evidence

**Push without reconnect (AC3, AC5).** A session using the server's default view opened
the `GET /mcp` stream (connecting, then open). Changing `Mcp:WorkflowViews:DefaultView`
on the running server moved its discovered set with one `tools/list` each time, on the
same MCP session (one initialize):

| DefaultView change | Discovered set | Time |
| --- | --- | --- |
| to `setup` | 0 to 8 | 0.5 s |
| back to `default` | 8 to 0 | 8.0 s |

**Release swap with reconnect (AC5).** Swapping releases on the same address changed the
routed set, with no SDK edit:

| Server | Routed |
| --- | --- |
| candidate `87966c3` | 8 |
| previous release `7ba4226` | 3, without get, update, preview, save and reopen |
| candidate again | 8 |

### AC4 evidence

Three legs each dispatched the full `create_draft`, `update_draft`, `validate_draft`,
`get_draft`, `save_version`, `reopen_version`, `propose_publication` path:

- a certified model turn through the proxy, 8 rounds, status `completed`, every
  transcript's provenance verified
- the admin key over MCP
- an end-user bearer over MCP

Values were checked against literal expectations, not against a snapshot of the output:

- **Map content:** Honolulu point ordinates `[-157.8583, 21.3069]`, feature id 7, null
  elevation, mutated view center `[-157.8167, 21.2833]`, zoom 11, CRS `EPSG:4326`,
  format `honua_map_package.v1`, and layer title and visibility.
- **Draft lifecycle:** each update advanced the generation by exactly one (1 to 2), and
  validation reported `valid`.
- **Saved version:** the version read back over REST carried the save response's content
  hash and the mutated view; reopen was bound to the saved version id.
- **Proposal:** propose returned `AwaitingApproval` with a `honua://proposals/{id}` URI.
- **Poll:** the owner read its own proposal three times, `200` each time, receiving the
  operation instance, audit id, correlation id, kind `StudioDraftMutation`, status
  `AwaitingApproval`, risk level and diff, as the admin key and as a bearer
  (honua-server#4910 stays fixed).
- **Publication stays governed:** afterwards the item's publication pointer read
  `null|<savedVersionId>` in Postgres — no version was published without approval.

### AC6 evidence

Refusals, all under the image's own token replay protection:

| Attempt | Result |
| --- | --- |
| Other owner reads, updates or saves the owner's draft | "The caller does not own this Studio resource." |
| Read-only scope updates | "The access token's scopes do not permit 'Create' on StudioDraft." |
| No-grant create | "You do not have permission to perform 'Create' on StudioDraft." |
| Owned draft proposed without a Publish grant | "'PublishRequest' requires a StudioDraft 'Publish' operator grant." |
| Another principal reads the owner's publication proposal | "The caller is not authorized to read this Studio publication proposal." |
| Anonymous create | `isError` |

- No refusal disclosed draft content.
- The durable draft's generation and owner were unchanged afterwards.
- Discovery is the same eight tools for every principal. The server treats discovery as
  not authority, so the refusals are invocation-time.
- The owner's own poll succeeds on this pin (see AC4), so the other-principal refusal now
  proves owner scoping rather than a blanket refusal.

### AC7 evidence

The check reads Studio at the committed HEAD. It then compiles an archive of that commit
twice: once against the `@honua/sdk-js` Studio pins (0.1.9-beta.0 from the registry) and
once against this checkout's SDK. The SDK-installed check verifies the second install by
hashing `dist/src/studio-agent/index.js`.

**Local list deleted: pass.**

- `src/chat/studio-agent-tools.ts` is not tracked, and nothing references
  `STATIC_STUDIO_AGENT_TOOLS`.
- No source passes a `studioTools` policy or an allowlist.
- No file both names a `honua_studio_*` tool and declares an `inputSchema`.
- Studio creates its agent with `createStudioAgentSession` from
  `@honua/sdk-js/studio-agent`. The tools it hands the session are only the SDK map kit's
  read tools and `selectFeature`, so composition tools come from discovery.
- For the record: the receipt lists the `honua_studio_*` names that Studio's canvas calls
  directly through its typed MCP client (`STUDIO_MCP_TOOL_NAMES`, `mcp/tool-bridge.ts`).
  A UI command resolves to one wire name there. That vocabulary is never given to the
  model or to discovery, so it is not the deleted list.

**Compiles on the same discovery surface: fail.**

| Step | Pinned `@honua/sdk-js` 0.1.9-beta.0 | SDK from this branch |
| --- | --- | --- |
| `npm run typecheck` | Pass | **Fail**: TS2322 at `src/elements/studio-chat-element.ts(476,79)` |
| `npm run build` | Pass | Pass (Vite does not typecheck) |
| SDK-discovery element test, run alone | 1 passed | **1 failed**: `expected undefined to be 9` |

Both failures come from honua-io/honua-sdk-js#1748. That is the provenance fix AC4's
certified model turn depends on, and it is not in the published 0.1.9-beta.0.

- **Type:** the fix added `transcriptProvenance` to the SDK's `StudioAiChatEventType`.
  Studio assigns the SDK's session chat events into its own copy of the proxy contract
  (`src/chat/ai-contract.ts`), which has no such member.
- **Runtime:** the session dispatches a model-selected action only with `certification`
  options and one verified provenance event. Studio's `attachAgentSession` passes no
  `certification`. In the element test, the model selects the discovered
  `honua_studio_set_view` and the turn ends at `messageStop` without dispatching.

Both are recorded on honua-io/honua-studio#71, and the fix belongs in Studio. For a
non-admin Studio user, certification is also refused by the proxy
(honua-io/honua-sdk-js#1744, below).

## Findings

- **honua-io/honua-sdk-js#1744 (open):** a non-admin end user cannot dispatch
  model-selected actions. The SDK requires certified transcript provenance
  ("Model-selected actions require exactly one terminal verified transcript provenance
  event"), and the proxy answers 403 to a non-admin certification request. The end-user
  AC4 leg therefore runs the same plan as a terminal MCP client. Recorded in the receipt
  as `end-user-model-turn-dispatch`, the run's only failing check; it is a finding, not
  an acceptance criterion.
- **Not a criterion, recorded for the record:** at `87966c3` the eleven granular
  composition verbs (`honua_studio_add_layer`, `honua_studio_set_view`, …) are served but
  not classified into `setup`, so the default policy does not route them. The lifecycle
  uses `update_draft`.
- **Regression guards still green:** honua-server#4909 (bearer MCP session continuity),
  #4910 (proposal owner poll) and #4919 (prompt budget; this run's largest round
  counted 16,158 of the 128,000 characters allowed).

## Reproduce

```bash
npm ci && npm run build
node scripts/qualify-studio-candidate.mjs <honua-release>/platform-manifest.yaml \
  --studio <honua-studio checkout> \
  --previous-image ghcr.io/honua-io/honua-server@sha256:dd50cd81c057e37e73a6144572abdfc90d48de314d7625c54c4ef3b6eb65b0fd \
  --previous-ref 7ba422672e0c751843b17beb36e954a019cc19fb
```

The command needs Docker with `postgis/postgis:16-3.4`, `redis:7.4-alpine`,
`alpine/openssl` and `node:22-alpine`, plus npm registry access for the Studio install.
It exits 1 while any acceptance check fails.
