# Studio candidate replay for honua-sdk-js#1397

`studio-candidate-replay.json` is the retained receipt of
`scripts/qualify-studio-candidate.mjs`. It replays the live acceptance criteria of
issue 1397 against the honua-server image that the release platform manifest pins.
The receipt's status is `failed`, and this document does not claim that the issue is
closed.

## What ran

- **Candidate:** `ghcr.io/honua-io/honua-server@sha256:29974ee7b722e3ae15c3b891024e5e70800f412188aeccf5ec3d32d9dac675c1`,
  image revision `548b7a5263da5a3f2381eb43f232687cdf92b0bf`. That matches the manifest
  candidate ref (manifest sha256 `02c076be…`), and the running image id was checked
  against the digest.
- **Previous release:** `sha256:dd50cd81…` (revision `7ba4226`), booted only for the
  release-swap check.
- **Deployment:** Production startup policy, fresh PostGIS and Redis, an OIDC resource
  server with a per-run HS256 key, a per-run operation key-ring certificate, and an
  Ed25519 transcript-signing key for the Studio AI proxy.
- **SDK:** built from `b97898d83` (the receipt's `sdkSourceSha`).
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

Two settings differ from the image's defaults. Both are declared in the receipt:

| Setting | Why | Tracked by |
| --- | --- | --- |
| `StudioAiProxy:MaxPromptCharacters=100000` | The default 32000 re-counts every Studio tool definition on each round. A certified map lifecycle is refused at its seventh round (propose). | honua-server#4919 |
| `Oidc:TokenValidation:EnableTokenReplayProtection=false`, end-user checks only | Under the default, a bearer principal cannot make a second request on its own MCP session. | honua-server#4909 |

## Acceptance criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| AC1 | Server-authored classification routed with no consumer allowlist | Pass | See [AC1](#ac1-evidence) |
| AC2 | `annotations` and `outputSchema` reach the model | Pass | See [AC2](#ac2-evidence) |
| AC3 | `tools/list_changed` over a real push channel refreshes without a reconnect | Pass | See [AC3 and AC5](#ac3-and-ac5-evidence) |
| AC4 | Terminal session executes mutate, validate, save/get/reopen, propose/poll | **Not met** | See [AC4](#ac4-evidence) |
| AC5 | Adding or removing a server Studio member changes the discovered set | Pass | See [AC3 and AC5](#ac3-and-ac5-evidence) |
| AC6 | A principal cannot invoke beyond server authorization | Pass, with the replay-protection deviation | See [AC6](#ac6-evidence) |
| AC7 | Browser Studio compiles against SDK discovery after deleting its local list | Open | honua-io/honua-studio#69 (closes honua-studio#70), checks green, awaiting merge |

### AC1 evidence

- Default `createStudioAgentSession` negotiated `setup` at initialize, as the admin key and as an end user.
- It routed exactly the eight members transcribed from server source (`setup.v2`, family `honua.studio.composition`).
- It refused the other 17 setup-view descriptors, then routed the same eight after reconnect.
- The full catalog (124 descriptors) classifies the same eight.

### AC2 evidence

- On all 8 provider rounds, every routed tool reached the provider with its input schema unchanged.
- Its annotations and output schema were present verbatim in the provider description: 8 of 8 tools carry both.
- No provider request contained a tool result without its assistant tool call.

### AC3 and AC5 evidence

**Push without reconnect (AC3, AC5).** A session using the server's default view opened the `GET /mcp` stream (connecting, then open). Changing `Mcp:WorkflowViews:DefaultView` on the running server moved its discovered set with one `tools/list` each time, on the same MCP session (one initialize):

| DefaultView change | Discovered set | Time |
| --- | --- | --- |
| to `setup` | 0 to 8 | 4.9 s |
| back to `default` | 8 to 0 | 7.2 s |

**Release swap with reconnect (AC5).** Swapping releases on the same address changed the routed set, with no SDK edit:

| Server | Routed |
| --- | --- |
| candidate | 8 |
| previous release | 3, without get, update, preview, save and reopen |
| candidate again | 8 |

### AC4 evidence

Three legs each dispatched the full `create_draft`, `update_draft`, `validate_draft`, `get_draft`, `save_version`, `reopen_version`, `propose_publication` path:
- a certified model turn through the proxy, 8 rounds, every transcript's provenance verified
- the admin key over MCP
- an end user over MCP

Values were checked against literal expectations:
- **Map content:** Honolulu point ordinates, null elevation, view center, zoom and CRS, and layer title and visibility.
- **Draft lifecycle:** each update advanced the generation by exactly one, and validation was `valid`.
- **Saved version:** its hash matched the stored version, and reopen was bound to it.
- **Proposal:** propose returned `AwaitingApproval` with a `honua://proposals/{id}` URI. The harness checks the publication pointer only after the poll, so this receipt does not evidence it.

Every leg then failed to poll its own proposal, with `permission_denied` (honua-server#4910).

### AC6 evidence

Refusals:

| Attempt | Result |
| --- | --- |
| Other owner reads, updates or saves the owner's draft | `permission_denied` |
| Read-only scope updates | `insufficient_scope` |
| No-grant create | `permission_denied` |
| Owned draft proposed without a Publish grant | `permission_denied` |
| Anonymous create | `isError` |

- The durable draft generation and owner were unchanged afterwards.
- Discovery is the same eight tools for every principal. The server treats discovery as not authority, so the refusals are invocation-time.
- The other principal's proposal read was also refused, but the owner is refused identically (#4910), so that row does not prove owner scoping.

## SDK defects found and fixed by this replay

Each of these stopped every certified model turn against the candidate.

1. **Signed request compared as a raw string.** `StudioAiTranscriptVerifier` compared the
   signed request to its own `JSON.stringify` output. honua-canonical-json-v1 uses the
   server's JSON escaping, so the real tool descriptions (apostrophes, backticks) never
   matched. It now decodes the signed request and compares values; the digest and
   signature still bind the exact bytes.
2. **Signed event types spelled differently.** The server signs provider event types with
   its enum spelling (`MessageStart`), while the SDK types events from the SSE `event:`
   line (`messageStart`). Signed types are now mapped through a fixed table before the
   value comparison. A type naming a different event still fails.
3. **Assistant tool calls never recorded.** The session did not record the assistant's
   tool calls, so every follow-up round sent tool results that answer no assistant tool
   call. OpenAI-compatible and Anthropic providers reject that. Dispatching rounds now
   carry `message.toolCalls`.

## Findings filed

- **honua-server#4909:** bearer MCP sessions fail under default replay protection.
  - Reusing the session's token gets 401 (`OIDC token replay detected`).
  - A fresh token gets a principal mismatch.
- **honua-server#4910:** a Studio publication proposal's owner, bearer or API key,
  cannot read its status. Propose and read use different actor-id formats.
- **honua-server#4919:** the default `MaxPromptCharacters` stops the lifecycle at propose.
- **honua-io/honua-sdk-js#1744:** a non-admin end user cannot dispatch model-selected
  actions.
  - The SDK requires certified provenance.
  - The proxy returns 403 to non-admin certification.
- **Not a criterion, recorded for the record:** at `548b7a5` the eleven granular
  composition verbs (`add_layer`, `set_view`, …) are served but not classified into
  `setup`, so the default policy does not route them. The lifecycle uses `update_draft`.

## Reproduce

```bash
npm ci && npm run build
node scripts/qualify-studio-candidate.mjs <honua-release>/platform-manifest.yaml \
  --previous-image ghcr.io/honua-io/honua-server@sha256:dd50cd81c057e37e73a6144572abdfc90d48de314d7625c54c4ef3b6eb65b0fd \
  --previous-ref 7ba422672e0c751843b17beb36e954a019cc19fb
```

The command needs Docker with `postgis/postgis:16-3.4`, `redis:7.4-alpine`,
`alpine/openssl` and `node:22-alpine`. It exits 1 while any acceptance check fails.
