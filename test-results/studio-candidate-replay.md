# Studio candidate replay for honua-sdk-js#1397

`studio-candidate-replay.json` is the retained receipt of
`scripts/qualify-studio-candidate.mjs`. It replays the live acceptance criteria of
issue 1397 against the honua-server image that the release platform manifest pins.
The receipt's status is `passed`: every acceptance check in it passed on this
candidate. AC7 is owned by another repository and is not part of that status.

## What ran

- **Candidate:** `ghcr.io/honua-io/honua-server@sha256:0b16046533e5330ecdd48255c06b5397e869191299e1e5e8cc7b4b2ded60b388`
  (`nightly-8862065`), image revision `886206527cc97bad1bbaa5fa6358910ebc45e9c0`. That
  matches the manifest candidate ref (manifest sha256 `120a99cb…`, honua-release#354),
  and the running image id was checked against the digest.
- **Previous release:** `sha256:dd50cd81…` (revision `7ba4226`), booted only for the
  release-swap check.
- **Deployment:** Production startup policy, fresh PostGIS and Redis, an OIDC resource
  server with a per-run HS256 key, a per-run operation key-ring certificate, and an
  Ed25519 transcript-signing key for the Studio AI proxy.
- **SDK:** built from this branch (the receipt's `sdkSourceSha`).
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

**No deployment deviations.** The `548b7a5` replay had to raise
`StudioAiProxy:MaxPromptCharacters` and switch OIDC token replay protection off for its
end-user checks. This pin ships a default prompt budget sized for the setup-view
lifecycle (honua-server#4919 — the largest round of this run counted 16,154 of the
128,000 characters allowed) and continues a bearer MCP session under replay protection
(#4909), so every check ran under the image's own configuration and the receipt's
`deploymentDeviations` is empty.

The candidate binds a bearer to the surface it is first admitted on (#4899) and, on
`/mcp`, to the session it opens (#4909). The harness therefore models a real OAuth
client: it holds one access token for the ordinary HTTP API and one per MCP session, and
presents a newly issued token when it opens another session. That is recorded as a
contract check (`bearer-token-is-bound-to-one-mcp-session`), not assumed:

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
| AC7 | Browser Studio compiles against SDK discovery after deleting its local list | Open elsewhere | honua-io/honua-studio#69 (closes honua-studio#70), awaiting merge in that repository |

### AC1 evidence

- Default `createStudioAgentSession` negotiated `setup` at initialize, as the admin key
  and as an end-user bearer, with no consumer-configured allowlist.
- It routed exactly the eight members transcribed from honua-server source at
  `8862065` (`setup.v2`, family `honua.studio.composition`, view `setup`).
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
| to `setup` | 0 to 8 | 4.3 s |
| back to `default` | 8 to 0 | 7.8 s |

**Release swap with reconnect (AC5).** Swapping releases on the same address changed the
routed set, with no SDK edit:

| Server | Routed |
| --- | --- |
| candidate `8862065` | 8 |
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
  `AwaitingApproval`, risk level and diff. This is the criterion that failed on the
  previous pin (honua-server#4910); it now passes as the admin key and as a bearer.
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

## Findings

- **honua-io/honua-sdk-js#1744 (open):** a non-admin end user cannot dispatch
  model-selected actions. The SDK requires certified transcript provenance
  ("Model-selected actions require exactly one terminal verified transcript provenance
  event"), and the proxy answers 403 to a non-admin certification request. The end-user
  AC4 leg therefore runs the same plan as a terminal MCP client. Recorded in the receipt
  as `end-user-model-turn-dispatch`, the run's only failing check; it is a finding, not
  an acceptance criterion.
- **Not a criterion, recorded for the record:** at `8862065` the eleven granular
  composition verbs (`honua_studio_add_layer`, `honua_studio_set_view`, …) are served but
  not classified into `setup`, so the default policy does not route them. The lifecycle
  uses `update_draft`.
- **Closed by this pin:** honua-server#4909 (bearer MCP session continuity),
  honua-server#4910 (proposal owner poll) and honua-server#4919 (prompt budget) were
  filed by the `548b7a5` replay and are all fixed here; the checks that found them are
  retained as regression guards.

## Reproduce

```bash
npm ci && npm run build
node scripts/qualify-studio-candidate.mjs <honua-release>/platform-manifest.yaml \
  --previous-image ghcr.io/honua-io/honua-server@sha256:dd50cd81c057e37e73a6144572abdfc90d48de314d7625c54c4ef3b6eb65b0fd \
  --previous-ref 7ba422672e0c751843b17beb36e954a019cc19fb
```

The command needs Docker with `postgis/postgis:16-3.4`, `redis:7.4-alpine`,
`alpine/openssl` and `node:22-alpine`. It exits 1 while any acceptance check fails.
