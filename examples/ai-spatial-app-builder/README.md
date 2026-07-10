# Honua Safe Agent Workbench

This flagship demonstrates the difference between an agent proposing spatial work and the SDK authorizing an effect. The deterministic default requires no model, network, or credentials.

## Safety workflow

1. An untrusted deterministic proposal declares typed tool calls and requested effects.
2. `explainQuery` builds an immutable plan bound to the source locator, capabilities, schema/source versions, authorization scope, query, CRS, limits, estimates, and execution policy.
3. Policy validation is side-effect free. Unsupported tools, tool/operation mismatches, excessive limits, unapproved fields, mutation, realtime, or generated-app effects are visibly refused. Source-native predicates must pass a restricted parser; comments, functions, statement separators, unapproved fields, and widening fragments such as `OR 1=1` fail closed.
4. A reviewer can inspect request/row/byte estimates, fidelity, cache behavior, provenance, and row/byte ceilings before approving, narrowing, or rejecting. The approval grant binds the exact validated-plan digest and cannot widen its limits.
5. `executeQueryPlan` rechecks plan integrity and current source context before the first read. Tampering, stale context, pre-abort, or authorization drift fails before source access. Revalidation, reset, and disposal abort and invalidate in-flight generations so late results cannot commit.
6. Successful execution creates a tamper-evident `honua.agent-execution-receipt` binding the plan, approval, result byte count, provenance, scope, and deterministic observation time. Oversized payloads fail before rows or a success receipt commit.

Mutation and realtime are not disguised as read-only operations. They require separate host capabilities and approvals and remain disabled in this sample policy.

Prompt text is never authority. Tool names, effects, planned operations, projected/filter/sort fields, CRS, authorization scope, row limits, and byte limits are independently checked against host policy even when a prompt attempts to relabel or bypass them.

## Fixture and optional host lanes

Fixture mode replays committed parcel rows and an honest GeoServices query plan. “AI” means the proposal boundary being demonstrated; no model is called or implied. Injected sources must supply an explicit source binding, including data mode, observation time, attribution, versions, and authorization scope; arbitrary sources cannot inherit the fixture provenance label.

Optional model and live-data integrations must be mediated by a trusted same-origin host. Provider keys, bearer tokens, and approval credentials must never be placed in Vite variables or browser storage. The scheduled evidence runner accepts only host endpoint locations:

```bash
HONUA_AGENT_HOST_URL=https://host.example.test/proposal \
HONUA_LIVE_DATA_URL=https://host.example.test/data \
npm run demo:ai-spatial-builder:live-evidence
```

Without both endpoints the runner emits a structured `skipped` record and never substitutes fixture output while claiming live execution.

This sample demonstrates the browser-side contract boundary; it does not implement or claim completion of the production host integration tracked in #397.

## Validation

```bash
npm run demo:ai-spatial-builder:typecheck
npm run demo:ai-spatial-builder:build
npm run demo:ai-spatial-builder:evidence
npm run test:playwright:ai-spatial-builder
npm test -- test/ai-spatial-app-builder.test.ts
```

Committed `evidence/fixture.v1.json`, `evidence/live-skipped.v1.json`, and `presentation.v1.json` are versioned sample-contract assets for honua.io.
