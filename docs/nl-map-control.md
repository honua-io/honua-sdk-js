---
type: reference
title: "Natural-language map control (`@honua/sdk-js/nl-map-control`)"
description: "Turn a natural-language instruction into a typed, inspectable plan over the agent tools and execute only reviewed plans: safety model, API, self-correction, the MCP path and errors."
resource: "honua://capability/ai.agent-operations"
---
# Natural-language map control (`@honua/sdk-js/nl-map-control`)

> **Experimental.** Symbols on this subpath are `@experimental` and may change
> in any minor release before `1.0.0`.

`@honua/sdk-js/nl-map-control` turns a natural-language instruction into a
typed, serializable, inspectable plan over the existing
[`agent-tools`](../src/agent-tools/index.ts) surface, and executes only
reviewed plans. It composes three things the SDK already ships:

- **agent-tools** — the ten bounded JSON-Schema map/runtime tools
  (`inspectMap`, `listSources`, `setViewport`, `addLayer`, `setFilter`,
  `selectFeature`, `runWidgetQuery`, `explainCapabilityGap`, …),
- **query-planner** — the canonical query IR that data operations are
  expressed in, and
- **agent-safety** — signed approval envelopes, effect budgets, and receipts.

There is intentionally **no opaque NL execution path**: per the
[north-star ADR](./decisions/north-star-sdk-application-kernel.md), an agent
prompt must compile to the same typed, inspectable plan that human-authored
code uses.

## Safety model

1. **Plan-first.** `propose(instruction)` returns a serializable
   `NlMapPlan` — ordered agent-tool invocations for map operations, with
   query-planner IR attached to data operations — and never executes
   anything. The plan is content-addressed: `fingerprint` is the SHA-256 of
   its canonical JSON, and `execute()` recomputes it, so a plan edited after
   review is rejected (`plan-invalid`).
2. **Plans only.** `execute()` is the single execution path and accepts plans
   only. Passing raw natural language (or anything that is not a
   `honua.nl-map-plan`) throws a typed `plan-required` error.
3. **Policy-gated read auto-execution.** A plan whose every step is `read`
   may auto-execute when `policy.autoExecuteReadOnly` allows it (the
   default). Set it to `false` to require approval for everything.
4. **Envelopes for effects.** Any plan containing a `viewport` or `mutation`
   step requires a signed agent-safety approval envelope. The envelope is a
   real `agent-safety` approval: the plan is deterministically projected into
   an `AgentPlanV1`, dry-run against a policy, signed by a host-owned signer,
   and verified (signature, expiry, policy, bindings, and per-step parameter
   digests) before anything runs. An approval issued for one plan does not
   verify against another.
5. **Receipts.** Every execution — auto or approved — emits an
   `NlMapPlanReceipt` recording the plan identity, mode, per-step tool
   status, and outcome. Receipts are content-addressed (`receiptDigest`) and
   optionally signed with a host-provided `receiptSigner`.
6. **BYO LLM.** The model transport is a caller-provided callback
   `(request: NlCompletionRequest) => Promise<NlCompletionResponse>`. The SDK
   depends on no model-vendor SDK, sends the model only the bounded tool
   schemas plus the semantic map context, and persists no NL or model output.

## API walkthrough

```ts doc-test=skip reason="requires a live map host and an LLM callback"
import {
  approveNlMapPlan,
  createNlMapControl,
  nlMapRuntimeBinding,
} from "@honua/sdk-js/nl-map-control";

const nl = createNlMapControl({
  // Any HonuaAgentRuntime adapter: a HonuaController, a MapPackage runtime,
  // or your own object over a MapLibre map.
  tools: { runtime },
  // Bring your own model. Any provider, any transport.
  llm: async (request) => callMyModel(request),
  policy: { autoExecuteReadOnly: true, maxSelfCorrections: 2, actor: "app@example" },
  approvalVerifier, // host-owned envelope verifier (agent-safety)
});

// 1. Compile NL into an inspectable plan. Nothing executes here.
const plan = await nl.propose("zoom to downtown and only show open incidents");
console.log(JSON.stringify(plan, null, 2)); // render for human review

// 2. Read-only plans can run directly; effectful plans need an envelope.
if (plan.readOnly) {
  const { receipt } = await nl.execute(plan);
} else {
  const approval = await approveNlMapPlan({
    plan,
    actor: "app@example",
    approver: "operator@example",
    signer, // host-owned envelope signer
    bindings: {
      map: nlMapRuntimeBinding({ observedAt: new Date().toISOString() }),
      incidents: incidentsSourceBinding, // agent-safety source binding
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const { receipt } = await nl.execute(plan, { approval });
  console.log(receipt.outcome, receipt.approvalDigest);
}
```

### The completion contract

`NlCompletionRequest` carries everything a provider adapter needs: the
`system` prompt (semantic map context from agent-tools), the user
`messages`, and the tool schemas in provider-neutral MCP-compatible shape
(`{ name, description, inputSchema }`). Adapters map those onto their
provider's native function-calling API and return
`{ toolCalls: [{ name, arguments }] }` — `arguments` may be a parsed object
or a raw JSON string. A provider refusal is returned as `{ refusal }` and
surfaces as a typed `refusal` error.

### Self-correction

When a completion fails validation — an unknown tool, arguments that fail
the JSON schema, an invalid canonical query, or a **capability miss** — the
layer sends a structured retry (`purpose: "self-correct"`) containing the
previous tool calls and typed `issues`. Capability misses embed the full
`explainCapabilityGap` output (supported flag, declared capabilities, and a
suggested action) so the model can re-plan against a source that actually
supports the operation. Retries are bounded (`maxSelfCorrections`, default
2); exhaustion throws `retries-exhausted` carrying the final issues.

### Deterministic replay

`createRecordedNlLlm(exchanges)` replays committed request/response
fixtures in order and fails loudly on drift. The gallery demo (`npm run demo:nl-map-control`) replays recorded
completions, so it is deterministic with no API key.

## The MCP path

The NL layer's tool surface is published through the same agent-tools
exporters used by `@honua/mcp-server`, so the capability works in-app and
over the Model Context Protocol:

```ts doc-test=skip reason="illustrative tool publication snippet"
import {
  toNlMapControlMcpToolDefinitions,
  toNlMapControlOpenAiToolDefinitions,
} from "@honua/sdk-js/nl-map-control";

// proposeMapPlan + executeMapPlan + the ten agent tools
const mcpTools = toNlMapControlMcpToolDefinitions();
const openAiTools = toNlMapControlOpenAiToolDefinitions();
```

`proposeMapPlan` is a read tool (planning only); `executeMapPlan` is an
action tool that requires opt-in and accepts a serialized plan plus the
approval bundle indicated by the proposal's `approvalRequired` field.
`@honua/mcp-server` hosts these definitions through
`createNlMapControlMcpHost` and `createServer(client, { nlMapControl })`. The
MCP boundary additionally requires an atomic approval-use consumer, matches
transport authorization scopes to the exact signed source binding, verifies the
approval before inspecting its requested scopes, propagates cancellation, and
refuses credential/cursor/endpoint-bearing plans before mutation. Plans and
approvals are snapshotted as bounded JSON without invoking accessors before any
asynchronous authorization callback. Its content-addressed execution receipt
omits the raw instruction and tool result payloads while retaining the exact
plan and SDK receipt digests.

Unlike the in-app controller's default read-only auto-execution policy, the MCP
host also requires an approval for a read-only step that names a `sourceId`
(including `runWidgetQuery`). The signed source binding is the authority from
which the host derives required transport scopes; without it, a protected-source
read is refused before the runtime is called. Read-only map inspection that does
not name a source can still use the controller's auto-execution policy.

## Ask this map review control

`createAskMapSession` adds a framework-neutral review lifecycle over an existing
`NlMapControl`. Supply a JSON-compatible `context()` snapshot, a `createControl`
factory, a pure plan-review function and an atomic result renderer. Include
source/schema/version and authorization identity, captured viewport, selection
and refinement context in the snapshot. Call `invalidate()` when those inputs
change. The session compares the context again before execution and result
application; it consumes each review once, cancels old work, and suppresses stale
responses. It stores no conversation history.

`mountAskMapControl` supplies labelled prompt entry, suggestion buttons, keyboard
review/execution/rejection, a live status region and expandable diagnostics. The
host owns map and table rendering. Recorded mode makes the prompt read-only;
live mode permits free text. Throw `HonuaAskMapClarification` from a completion
adapter when a question needs user input. Clarification is not an executable
plan. The sample shows explicit loading, review, empty, refused, cancelled and
failed outcomes.

The default request bound is 15 seconds; `timeoutMs` accepts 1–120,000 milliseconds.
The factory's `AbortSignal` spans proposal and execution, including the host's
query runtime. The existing LLM callback receives an optional second argument
`{ signal }`, so authenticated transports can abort network requests. A callback
that ignores cancellation still cannot replace a newer UI state. If host policy
requires approvals, supply `approve`; the returned bundle still passes through
`NlMapControl.execute` and its existing verifier.

`createNlMapControl({ validateStep })` lets a host admit source-grounded query
calls during the existing bounded correction loop and again before execution.
The hook returns typed `NlPlanIssue` entries and must remain free of effects.
A `runWidgetQuery` call carrying `semanticQuery` requires the explicit runtime
method `runSemanticWidgetQuery`; legacy `runWidgetQuery` hosts are never given an
AST they might silently ignore. Validate against the actual source schema,
compile with the supported backend compiler, refuse unsupported/approximate
results, and execute only that admitted artifact. Never execute model-generated
SQL. The incident sample does this with the existing semantic DuckDB compiler and
parameterized DuckDB-WASM driver.

The control remains experimental. The [sample README](../examples/nl-map-control/README.md)
distinguishes deterministic semantic checks from the separately authenticated
live-model evaluation and documents its current qualification gaps.

## Errors

All failures are typed `HonuaNlMapControlError`s with a `code`:

| Code | Meaning |
|------|---------|
| `refusal` | The model declined the instruction. Not retried. |
| `retries-exhausted` | No valid plan within the self-correction budget; `issues` carries the typed reasons (including `explainCapabilityGap` output). |
| `plan-required` | `execute()` received something other than a proposed plan (for example raw NL). |
| `plan-invalid` | Plan content does not match its fingerprint, or is structurally invalid. |
| `approval-required` | The plan has `viewport`/`mutation` effects and no envelope was supplied (or read auto-execution is disabled). |
| `approval-invalid` | Envelope verification failed, or the envelope does not bind to this plan. |
| `fixture-mismatch` | A recorded-replay LLM saw a request that drifted from the recording. |
| `invalid-options` | Missing runtime, LLM callback, or source binding. |

Approval issuance itself uses `agent-safety` and throws
`HonuaAgentSafetyError` (for example `policy-denied` when the policy forbids
the plan's effects).

## See also

- [`docs/agent-safety.md`](./agent-safety.md) — the envelope, budget, audit,
  and receipt contracts this layer builds on.
- [`docs/agent-safety-threat-model.md`](./agent-safety-threat-model.md) — the
  threat model for the (stable) `agent-tools`/`agent-safety` surface underneath
  this layer: envelope forgery, replay, effect-budget bypass, receipt
  tampering, and plan-fingerprint mismatch, each with its conformance test.
- [`examples/nl-map-control/`](../examples/nl-map-control/) — deterministic
  MapLibre query sample with recorded suggestions, a grounded review control,
  synchronized results and a separately authenticated live-model adapter.
- [North-star ADR](./decisions/north-star-sdk-application-kernel.md) — why NL
  must compile to the same plan human code uses.
