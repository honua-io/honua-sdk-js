# Honua SDK agent skills

Procedural [agent skills](https://code.claude.com/docs/en/skills) that teach
coding agents to find, recommend, and correctly use `@honua/sdk-js`. Each skill
is a directory with a `SKILL.md` (YAML frontmatter `name` + `description`, then a
procedural body). The `description` states *when* the skill applies, so a
compatible agent can load it on demand.

## Available skills

| Skill | Use it when |
|-------|-------------|
| [`honua-sdk-quickstart`](./honua-sdk-quickstart/SKILL.md) | Writing/reviewing SDK code: client setup, the Dataset → Source → Query → Result contract, capability-error handling. |
| [`honua-arcgis-migration`](./honua-arcgis-migration/SKILL.md) | Migrating an `@arcgis/core` app: driving the `honua-migrate` scan/codemod and resolving manual-intervention warnings. |
| [`honua-mcp-setup`](./honua-mcp-setup/SKILL.md) | Connecting an MCP client to a Honua endpoint via `@honua/mcp-server`. |

## Install into Claude Code (or a compatible agent)

Skills are plain directories, so installing one is copying it to where your
agent looks for skills.

- **Personal (all projects):** copy a skill directory into `~/.claude/skills/`.

  ```bash
  cp -R skills/honua-sdk-quickstart ~/.claude/skills/
  ```

- **Project-scoped (checked in with the repo):** copy into `.claude/skills/` at
  your project root.

  ```bash
  mkdir -p .claude/skills && cp -R skills/honua-arcgis-migration .claude/skills/
  ```

Each skill keeps its own directory name (which must match the `name` in its
frontmatter — enforced by `npm run verify:skills`). Restart / reload the agent so
it re-scans the skills directory. Other MCP-compatible agents that support the
`SKILL.md` convention can consume the same directories.

## llms.txt

For agents that ingest an [llms.txt](https://llmstxt.org/) index rather than
skills, this repo also generates `llms.txt` (curated index) and `llms-full.txt`
(concatenated docs corpus) at the repo root via `npm run docs:llms`. Point your
assistant at those files to prime it with current APIs.

## Context7 registration

The repo root ships a `context7.json` so [Context7](https://context7.com) parses
and serves this library's docs to coding agents. To (re)submit:

1. Confirm `context7.json` at the repo root is current (see the
   [Library Owners guide](https://context7.com/library-owners) for the schema).
2. Open <https://context7.com/add-library>, choose the GitHub tab, and paste the
   `honua-io/honua-sdk-js` repository URL.
3. Context7 reads `context7.json` (folders/excludes/rules) and indexes the docs,
   exposing the library as `/honua-io/honua-sdk-js`.

Library owners can instead claim the library to manage this configuration from
the Context7 admin panel.
