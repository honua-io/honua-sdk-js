---
name: honua-diagnostics
description: Use when a Honua call fails, a deployment looks unhealthy, or a candidate needs a Console approval receipt — capturing a sanitized diagnostic bundle with honua doctor, reading health/audit/operation status, distinguishing capability gaps from real failures, and staying inside bounded, reversible remediation. Covers 2026.1 zero-to-map stage 6 (console) and failure triage for stage 7 (artifact).
release: "2026.1"
stages: [console, artifact]
---

# Diagnostics and bounded remediation (stage 6: `console`)

Two jobs: figure out what actually broke, and stop before doing anything an
agent is not allowed to do.

## 1. Classify the failure first

Most "Honua is broken" reports are one of four things. Separate them before
touching remediation:

| Symptom | Actually is | Next step |
| --- | --- | --- |
| Structured `{ "available": false, "surface", "reason", "guidance" }` | Target has no such surface | Read `guidance`; stop. Not a bug. |
| `HonuaCapabilityNotSupportedError` | Protocol cannot express the query | `honua_explain_capability_gap` for the safe fallback |
| `HonuaJobFailedError` | GP job reached a terminal failure | Read job status + server error code; do not retry blindly |
| Empty result, no error | Genuinely no matching features | Confirm with `honua_count_features` before reporting a bug |

A capability gap is never "no features matched", and an empty result is never a
capability gap. Reporting one as the other sends the user hunting the wrong
thing. `docs/errors.md` has the full hierarchy and retry policy.

## 2. Capture a sanitized bundle

`honua doctor` builds a local, bounded support artifact against the vendored
`diagnostic-bundle.v1` schema. **It never uploads.**

```bash
honua doctor \
  --exchange ./failure.json \
  --classification customer-data \
  --redaction-acknowledged=true \
  --share-with-support=false \
  --output ./diagnostic-bundle.json \
  --json
```

- `--exchange` is one captured request/response pair. The *input* may contain
  raw values — it is read into memory and never copied to output.
- Classification and both consent flags are explicit and unprefilled. An agent
  must not choose them: ask the user.
- Start with `--share-with-support=false`, review the bundle, and only rerun with
  `true` when the user has decided to submit it.
- `--base-url <origin>` adds an anonymous, credential-free capability probe.
  Probe failure becomes a sanitized envelope and never removes the supplied
  failure.
- The emitter drops Authorization, Proxy-Authorization, Cookie, Set-Cookie, API
  keys, signatures, tokens, and every non-allowlisted header. `--json` prints a
  machine summary only — not the path, not body previews.

Full privacy boundary and read-only replay: `docs/diagnostic-bundles.md`.

## 3. Read deployment health (Console stage)

Stage `console` of `mcp/release/zero-to-map/journey.v1.json` imports a Console
receipt bound to the exact connection, service, layers, GP jobs and result
identities, draft, admin proposal, execution operation, audit correlation, and
approved release candidate — plus health and recovery checks. The receipt is
produced by a human in Console. An agent gathers evidence for it; it does not
issue it.

Read-only operations worth reaching for (the `operate` group in
`docs/admin-cli-reference.md`):

- `getOpsHealthSnapshot` / `getOpsHealthHistory` — deployment health now and over
  time.
- `getRecentErrors`, `listObservabilityAlerts`, `getObservabilityAlert`.
- `getOperationStatus`, `listActiveOperations`, `getOperationsByType` — what is
  running.
- `getOperationProposal` — the state of a pending admin proposal.
- `exportObservabilityAudit` — audit trail for correlating what actually ran.
- `getMigrationStatus`, `getLicenseStatus`, `getAdminCacheStatus`.

For the local install specifically, `honua admin install status --directory <dir>`
is the fastest readiness check.

## 4. Bounded remediation — the hard limits

Remediation is where an agent does real damage. The boundaries:

- **Never self-approve.** `approveOperationProposal` is a human action. An agent
  may create or read a proposal; it does not approve its own.
- **Never fall back to a shared admin key** because a scoped credential was
  denied. A denial means re-read effective grants
  (`honua_admin_api_key_effective_permissions`) and ask for the grant — not
  escalate identity.
- **Never disclose secrets** in a diagnosis. Reference credentials by id and
  `referenceDigestSha256`. The journey's forbidden pointers
  (`/accessCredential/material`, `/secret`, `/apiKey`, `/adminKey`) are the rule.
- **Bound every action.** State the blast radius before acting; one attempt per
  distinct hypothesis; no unbounded retry loops; no "try everything" sweeps.
- **Prefer reversible.** Read-only diagnosis first. `setLayerEnabled false` and
  cache invalidation are reversible; `deleteConnection`, `deleteImportedRaster`,
  and re-importing with `overwriteExisting: true` are not — those need explicit
  human instruction.
- **Cancel rather than abandon.** `cancelOperation` / `cancelImportJob` /
  `honua_cancel_job` when a run is wrong or over deadline.

`docs/agent-safety.md` and `docs/agent-safety-threat-model.md` define the plan /
signature / approval / receipt boundary this rests on. Read them before
designing any autonomous remediation loop.

## Verify

- `docs/diagnostic-bundles.md` — `honua doctor`, privacy boundary, replay.
- `docs/errors.md` — error classes and recovery.
- `docs/agent-safety.md`, `docs/agent-safety-threat-model.md` — the safety
  boundary and what is deliberately out of scope.
- `docs/admin-cli-reference.md` — the `operate` and `secure` operation tables.
