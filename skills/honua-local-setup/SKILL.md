---
name: honua-local-setup
description: Use when installing Honua on a laptop for the first time and handing the resulting credential to an agent — running the control-plane Docker installer, verifying API/MCP/Console readiness, and wiring an MCP client to the local deployment without ever reading or echoing secret material. Covers 2026.1 zero-to-map stage 1 (install).
release: "2026.1"
stages: [install]
---

# Local setup and secure handoff (stage 1: `install`)

Stage 1 of the 2026.1 zero-to-map journey
(`mcp/release/zero-to-map/journey.v1.json`, stage `install`). Goal: a running
local Honua with API, MCP, and Console reachable, plus a scoped credential the
agent can *reference* but never read.

## 1. Install

The bootstrap MCP surface exposes exactly one tool,
`honua_admin_install_local` (`mcp/src/tools/admin-install-local.ts`). It is
registered only by `createBootstrapServer()`, so a laptop with no Honua yet can
still be driven by an agent. Enable it with `HONUA_MCP_BOOTSTRAP=1` on the
`honua-mcp` bin.

It is **not read-only**: the schema requires `confirm=true`. Never pass
`confirm` on the agent's own initiative — get an explicit human instruction
first.

The equivalent CLI, and what the journey actually records, is:

```bash
honua admin install local --profile gp-dev --yes --directory .honua-zero-to-map
```

Create `.honua-zero-to-map` outside the git repository you are editing.
`--http-port` defaults to `8080`. When that localhost port is already taken,
pass another one (`--http-port 18081`). `--dry-run` prints the compose file
and does not start containers. `--yes` is required before Docker starts.

`honua admin` is the control-plane CLI shipped by `@honua/sdk-js`. If `honua`
on `PATH` fails before Docker starts with `ModuleNotFoundError` for the Python
SDK, that `PATH` entry is the Python data-plane console script and its
checkout is missing. Reinstall that package from the live `honua-sdk-python`
tree (`python3 -m pip install -e packages/honua-sdk`). A working Python CLI
forwards `admin` to the JavaScript binary. When the JavaScript `honua` is not
the other `honua` on `PATH`, set `HONUA_JS_CLI` to `dist/src/cli/bin.js` from
`@honua/sdk-js`, or invoke that file with `node` and the same arguments.
Do not switch to the bootstrap MCP install tool to get around this: that tool
still requires an explicit human `confirm`.

## 2. Verify readiness before doing anything else

```bash
honua admin install status --directory .honua-zero-to-map
```

Do not advance to connections, imports, or geoprocessing until `ready` is
true. That flag is `/healthz/ready`. Container health only checks
`/healthz/live`, so a healthy container can still be Not Ready while the
database migration is failing. A 503 here is an install failure, not a data
problem, and retrying downstream calls will only produce misleading errors.
The installer creates the PostGIS and pgRouting extensions in the `public`
schema before the server migrates, then seeds `public.zero_to_map_parcels`
(one polygon, `parcel_id`, SRID 4326). It also sets `HONUA_LOCAL_DB_PASSWORD`
on the server to the full `Host=postgres;...` connection string. Re-run the
same install command after a compose change; it reuses the directory and does
not print the admin key. `honua` on PATH must be this control-plane CLI.
`honua admin`, `honua map`, and `honua services` are the same program. A
Python `honua` that only implements `services`, `layers`, `style`, and
`doctor` is the data-plane shim; once its package imports, a console
invocation forwards to this CLI.

## 3. Secure handoff — the part agents get wrong

The installer returns an `accessCredential` **descriptor**, not a secret. The
journey captures only:

- `/accessCredential/id`
- `/accessCredential/requestedGrants`
- `/accessCredential/effectiveGrants`
- `/accessCredential/referenceDigestSha256`

and declares `/accessCredential/material`, `/accessCredential/secret`,
`/accessCredential/apiKey`, and `/adminKey` as forbidden pointers. Treat that
list as the rule, not as journey trivia:

- Never print, log, summarize, or copy credential material into a plan,
  transcript, commit, or skill.
- Reference the credential by id and by `referenceDigestSha256`. If you need to
  prove which credential is in play, compare digests — do not fetch the value.
- Pass secrets to the server by reference (`secretType: "environment"` with a
  `secretReference` such as `env:HONUA_ZERO_TO_MAP_DB_CONNECTION`), never inline.
- `requestedGrants` and `effectiveGrants` can differ. The effective set is the
  truth; if a later call is denied, re-read the effective grants instead of
  escalating to a shared admin key.

The CLI enforces the same boundary: the one-time-secret admin operations fail
closed unless `--secret-output <new-private-file>` is supplied, and `--dry-run`
replaces credential-bearing values with `[REDACTED]`
(`docs/admin-cli-reference.md`).

## 4. Wire the MCP client

The local deployment exposes one MCP catalog at `/mcp`. Bridge a stdio client
to it with the `honua-mcp-proxy` bin rather than reimplementing the catalog:

```bash
HONUA_MCP_REMOTE_URL="https://localhost:8443/mcp" honua-mcp-proxy
```

Auth env vars are `HONUA_MCP_AUTH_TOKEN` (sent as `Authorization: Bearer`) and
`HONUA_API_KEY` (sent as `x-api-key`). Set them in the client's process
environment; do not embed them in a config file that gets committed.

For the platform-free path — pointing at any public FeatureServer with no Honua
server at all — use the `honua-mcp` bin and the `honua-mcp-setup` skill instead.

## Verify

- `docs/admin-cli-reference.md` — every `honua admin` operation, and the
  credential/HTTPS rules.
- `docs/auth.md` — credential stores, transports, and refresh behavior.
- `mcp/release/zero-to-map/journey.v1.json` — the executable stage definition.
- `docs/zero-to-map-release-journey.md` — what each stage must prove.
