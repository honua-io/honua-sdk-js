# Honua SDK JS Agent Instructions

## GitHub Issues

When the user asks for a ticket, backlog item, epic, workstream, or GitHub issue:

- Create the issue with `gh issue create` in the owning repository. Do not leave the work only in chat or a temporary docs file unless the user explicitly asks for a draft.
- Search existing open and closed issues before filing to avoid duplicates.
- For work that primarily demonstrates or exercises the JavaScript SDK, examples, MCP package, or migration tooling, default to `honua-io/honua-sdk-js`.
- For work that spans the Honua platform, create an umbrella issue in the coordinating repo and child issues in implementation repos when the scope is concrete enough. If only one issue is requested, include an `Affected repos` section.
- Use existing labels when practical: `enhancement`, `area/sdk`, `area/mcp`, `area/server`, `area/infrastructure`, `phase/MVP`, `phase/Beta`, `priority/P*`, and `effort/*`.

## Specifica Requirement Format

Use the Specifica format for product backlog issues, epics, and cross-repo workstreams. The issue body should be requirement-first and traceable, not a loose idea note.

Every workstream must be in Specifica. If the owning repo already has a
canonical Specifica source tree or projection workflow, follow that repo's
pattern instead of hand-editing GitHub as the source of truth. For example,
`honua-agentflow` uses `scripts/sync_specifica_issue.py` to project
`spec.md`, `design.md`, and `tasks.md` from a `.specifica/<slug>/` item into a
GitHub issue. In that style, update the canonical markdown and sync the issue;
the issue body is a projection.

When no repo-local Specifica tree exists, create the GitHub issue directly with
the Specifica sections below. Do not file broad workstreams, demo backlogs,
platform contracts, or epics as free-form notes. If a broad roadmap item needs
scheduled implementation, split it into child Specifica feature issues before
work starts.

### Epic / Workstream Issue

```md
## Specifica

Type: Epic
Workstream: <short workstream name>
Owner repo: <repo>
Affected repos: <repo list>
Priority: <P0-P4>
Phase: <MVP/Beta/GA/Future>

## Context

<Why this workstream exists, who it serves, and how it fits the Honua platform.>

## User Outcomes

- <Outcome 1>
- <Outcome 2>

## Scope

- <In-scope capability>
- <In-scope capability>

## Non-Goals

- <Explicitly excluded work>

## Requirements

- REQ-001: <testable requirement>
- REQ-002: <testable requirement>

## Acceptance Criteria

- [ ] <observable acceptance criterion>
- [ ] <observable acceptance criterion>

## Dependencies

- <dependency or "None">

## Validation

- <tests, demos, CI gates, or manual validation required>
```

### Child Feature / App Issue

```md
## Specifica

Type: Feature
Parent epic: <issue link or "TBD">
Workstream: <same workstream as epic>
Owner repo: <repo>
Affected repos: <repo list>
Priority: <P0-P4>
Phase: <MVP/Beta/GA/Future>

## Context

<User problem and product context.>

## User Workflow

1. <User step>
2. <User step>
3. <User step>

## Requirements

- REQ-001: <testable functional requirement>
- REQ-002: <testable functional requirement>
- NFR-001: <performance, reliability, security, caching, or accessibility requirement>

## Acceptance Criteria

- [ ] <observable acceptance criterion>
- [ ] <observable acceptance criterion>

## Data, Caching, and Realtime Notes

- <Metadata cache expectations, live-data constraints, realtime cadence, or explicit no-cache decisions.>

## Validation

- <unit/integration/e2e/manual validation required>
```

For app backlog issues, prefer one epic that carries the workstream context and one child issue per sample application. The incident operations dashboard must be treated as realtime by default; do not describe it as a static dashboard unless the user explicitly changes that requirement.
