---
type: index
title: "SDK skill retirement record"
description: "Retained narrative and limits of the SDK skill evaluation; no skill ships without auditable paired-run receipts."
---
# SDK skill retirement record

The previous lane recorded the following narrative. Its per-arm transcripts, checker outputs, SDK revision, and immutable server identity were not retained in the available handoff. These results cannot be independently audited and do not qualify any skill for shipment. All ten skills are deleted. Failed or tied arms never justify retention; environment-blocked tasks do not establish whether a skill helps.

Reported date: 2026-11-06 PT. Model: Claude Code with `claude-opus-5-5`. One local Compose quickstart on port 18080. Each task ran twice: once with only that skill installed at `.claude/skills`, and once with no skill files. Both arms received the package README and `AGENTS.md` sections 1–6. Pass or fail is an independent check of the server or the artifact, not the model's own report. A wrong turn is a tool result with is_error set, or a shell result whose text contained a traceback, the word unauthenticated, isError set to true, or a status of error.

The previous lane used this decision rule: a skill stays only when the run with it passes and the run without it fails, or both pass and the run with it has fewer wrong turns.

| Skill | Without | With | Decision |
| --- | --- | --- | --- |
| honua-local-setup | Pass, ready 200, 12 tools, 0 wrong turns | Pass, ready 200, 12 tools, 0 wrong turns | Deleted |
| honua-datasource-connect | Fail, secret reference refused, 1 wrong turn | Fail, `env:HONUA_LOCAL_DB_PASSWORD` refused, 1 wrong turn | Deleted |
| honua-publish-layers | Fail, stopped unauthenticated, 1 wrong turn | Fail, stopped unauthenticated, 1 wrong turn | Deleted |
| honua-diagnostics | Pass, bundle share false, ready 200, 0 wrong turns | Pass, bundle share false, ready 200, 0 wrong turns | Deleted |
| honua-mcp-setup | Pass, 12 tool names, 2 wrong turns | Pass, 12 tool names, 0 wrong turns | Deleted; receipts unavailable |
| honua-sdk-quickstart | Fail, HTTP 499, 2 wrong turns | Fail, HTTP 499, 0 wrong turns | Deleted |
| honua-geoservices-migration | Fail, HTTP 499, 0 wrong turns | Fail, HTTP 499, 0 wrong turns | Deleted |
| honua-style-verify | Fail, no style applied, 3 wrong turns | Fail, no style applied, 1 wrong turn | Deleted |
| honua-geoprocessing | Fail, authentication required, 0 wrong turns | Fail, authentication required, 2 wrong turns | Deleted |
| honua-map-composition | Fail, no saved version, 4 wrong turns | Fail, no saved version, 2 wrong turns | Deleted |

## Local setup

Task: run this package's quickstart and prove `/healthz/ready` returns 200 and the serving `/mcp` URL lists tools.

Both arms ran `python3 quickstart.py`. Ready returned 200 and `tools/list` returned 12 tools. Neither run had a wrong turn. The skill describes `honua admin install local`, which is not this package. The unaided run was already enough.

## Datasource connect

Task: save a connection named `sdk_ds_<arm>` and prove `honua_admin_connections_test` reports it healthy.

The quickstart does not permit the skill's `env:HONUA_LOCAL_DB_PASSWORD` reference. The with-arm sent that reference and the server returned 400. The without-arm also failed after other secret references were refused. Neither wrote `result.json`.

## Publish layers

Task: import `places.geojson` and publish service `sdk_places_<arm>` so an independent query of `population > 10000` returns 2.

Both arms stopped before ingest. `HONUA_API_KEY` was unset, and both treated `secrets/` as unreadable. The skill does not name the admin key file. No layer was published.

## Diagnostics

Task: run `honua doctor` on a captured exchange with classification `customer-data`, redaction acknowledged, and share-with-support false. Ready must return 200. The bundle must not contain the admin secret.

Both arms produced that bundle. Zero wrong turns. The skill did not beat the unaided run.

## MCP setup

Task: write `mcp-client.json` for a stdio client of this server's `/mcp`, with no secret literal in the file, and write `tool-names.txt` overlapping an independent `tools/list`.

Without the skill the agent ran `honua mcp` (unknown command) and imported a Python `mcp` module that is not installed, then wrote an `mcp-remote` client for `http://localhost:18080/mcp`. Twelve names matched.

With the skill the agent wrote `honua-mcp-proxy` and `HONUA_MCP_REMOTE_URL` on the first try. Twelve names matched, and the file did not contain the admin secret. The narrative reports fewer wrong turns, but the missing per-arm receipts prevent retaining the skill.

## SDK quickstart

Task: `query.mjs` using `@honua/sdk-js` must print `2` for `sdk_places_fixture` layer 1 where `population > 10000`.

The without-arm guessed `HonuaFeatureLayer`, which this package does not export, then called `client.featureLayer`. The with-arm used `queryFilter` as the skill says. Both requests reached the server and got HTTP 499. Neither printed 2.

## Geoservices migration

Task: `converted.mjs` must preserve `app.mjs`'s count using only `@honua/sdk-js`. `node converted.mjs` must print `2`.

Both arms wrote a script and both got HTTP 499. Neither printed 2.

## Style verify

Task: apply a preset this server publishes as the primary style of `sdk_places_fixture` layer 1, and read that preset back.

Both arms stopped when the style tools required a key they would not read. No `result.json`.

## Geoprocessing

Task: run `geometry.buffer` at distance 0.001, SRID 4326, and record a terminal job whose results contain the artifact id.

Both arms found the process and then stopped on authentication. No job was created.

## Map composition

Task: save a Studio map of `sdk_places_fixture` layer 1 and record item, version, and content hash. An independent `honua_studio_get_version` must return that hash.

Both arms listed the Studio tools and stopped when create required a key they would not read. No version was saved.
