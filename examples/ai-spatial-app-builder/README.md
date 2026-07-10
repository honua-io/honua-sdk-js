# Honua Safe Agent Workbench

This flagship demonstrates the difference between an agent proposing spatial work and the SDK authorizing an effect. The deterministic default requires no model, network, or credentials.

## Safety workflow

1. An untrusted deterministic proposal declares typed tool calls and requested effects.
2. `explainQuery` builds an immutable plan bound to the source locator, capabilities, schema/source versions, authorization scope, query, CRS, limits, estimates, and execution policy.
3. Policy validation is side-effect free. Unsupported tools, excessive limits, mutation, realtime, or generated-app effects are visibly refused.
4. A reviewer can approve, narrow, or reject. The approval grant binds the exact validated-plan digest and cannot widen its limits.
5. `executeQueryPlan` rechecks plan integrity and current source context before the first read. Tampering, stale context, or authorization drift fails before source access.
6. Successful execution creates a tamper-evident `honua.agent-execution-receipt` binding the plan, approval, result, provenance, scope, and deterministic observation time.

Mutation and realtime are not disguised as read-only operations. They require separate host capabilities and approvals and remain disabled in this sample policy.

Prompt text is never authority. Tool names, effects, fields, CRS, authorization scope, and row limits are independently checked against host policy even when a prompt attempts to relabel or bypass them.

## Fixture and optional host lanes

Fixture mode replays committed parcel rows and an honest GeoServices query plan. “AI” means the proposal boundary being demonstrated; no model is called or implied.

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
