# Decision — stabilize `/agent-tools` and `/agent-safety` (issue #502)

- **Status:** accepted
- **Date:** 2026-07-13
- **Owners:** SDK maintainers
- **Supersedes:** the "2 subpath-only experimental entrypoints" post-execution
  note in [`scope-split-and-1.0.md`](./scope-split-and-1.0.md); the stable-tier
  entrypoint count moves from 20 to 22, and
  [`config/public-surface.json`](../../config/public-surface.json) remains the
  exact machine-readable inventory.

## Context

`/agent-tools` (ten JSON-Schema map/runtime tools plus the bounded executor)
and `/agent-safety` (signed approval envelopes, effect budgets, single-use
consumption, execution receipts) shipped `@experimental`, which tells
enterprise adopters "do not build on this". Stabilization was deliberately
sequenced after the NL map-control layer (#509, `src/nl-map-control/`) exercised
both surfaces as a real consumer, and the in-repo MCP server has consumed
`/agent-tools` and `/agent-safety` throughout. With two independent consumers in
tree, the API review has usage evidence rather than speculation.

## Decision

Promote both subpaths to the **stable tier**: they enter the API report
(`api-report/stable-api.json`), the public-surface inventory
(`config/public-surface.json`, stable ceiling 20 → 22), the bundle-budget gate
(`/agent-tools` gains its first dedicated budget; `/agent-safety` already had
one), and the INSTALL.md / README stable enumerations. `@experimental` markers
are removed from both module docs. `/nl-map-control` **stays experimental**.
The security posture of the promoted surface is documented in
[`docs/agent-safety-threat-model.md`](../agent-safety-threat-model.md), with a
named conformance test per threat.

## Symbol disposition review (REQ-001)

Every exported symbol was dispositioned **keep / rename / drop**, informed by
actual imports in `src/nl-map-control/index.ts` (NL) and `mcp/src/**` (MCP).
Outcome: **118 keep / 0 rename / 0 drop** (56 in `/agent-tools`, 62 in
`/agent-safety`). No name was judged genuinely wrong, so no churn (and therefore
no deprecation shims) lands with the promotion. Two names were debated and
deliberately kept:

- `HonuaAiMapKit*` / `createHonuaAiMapKit` — "AI Map Kit" is the documented
  product name for the batteries-included facade (`docs/ai-map-kit.md`);
  renaming it at stabilization would orphan existing docs and demos for zero
  semantic gain.
- `HonuaGeneratedAppRuntimeLikeForAgents` — verbose, but precisely scoped
  (a structural "like" type for one adapter input) and app-facing only.

### `/agent-tools` (56 symbols — all keep)

| Symbol | Kind | Disposition | Evidence / rationale |
|---|---|---|---|
| `HONUA_AGENT_TOOL_NAMES` | const | keep | Imported by NL layer (tool-name union source of truth). |
| `HONUA_AGENT_TOOL_DEFINITIONS` | const | keep | Imported by NL layer; canonical tool catalog. |
| `HonuaAgentToolName` | type | keep | NL import; names the 10-tool union. |
| `HonuaAgentToolMode` | type | keep | `read`/`action` vocabulary used by definitions and policy. |
| `HonuaAgentToolStatus` | type | keep | NL import; result-status vocabulary. |
| `HonuaAgentProviderToolFormat` | type | keep | Exporter format selector (`honua`/`mcp`/`openai`). |
| `HonuaAgentJsonSchema` | interface | keep | NL import; JSON-Schema subset all tool schemas share. |
| `HonuaAgentToolDefinition` | interface | keep | NL import; canonical definition shape. |
| `HonuaAgentToolDefinitionLike` | interface | keep | NL import; lets higher layers publish extra tools via the same exporters. |
| `HonuaAgentViewport` | interface | keep | Runtime/adapter viewport contract. |
| `HonuaAgentSourceSummary` | interface | keep | NL import; snapshot source shape. |
| `HonuaAgentLayerSummary` | interface | keep | Snapshot layer shape. |
| `HonuaAgentMapSnapshot` | interface | keep | `inspectMap` result contract. |
| `HonuaAgentSelectionSummary` | interface | keep | `summarizeSelection` result contract. |
| `HonuaAgentWidgetQueryRequest` | interface | keep | `runWidgetQuery` input contract. |
| `HonuaAgentWidgetQueryResult` | interface | keep | `runWidgetQuery` output contract. |
| `HonuaAgentToolDegradedReason` | interface | keep | Degraded-result vocabulary (capability gaps). |
| `HonuaAgentRuntime` | interface | keep | NL import; the runtime-adapter seam the whole surface hangs off. |
| `InspectMapArgs` | interface | keep | Tool-args type (named per tool; mirrors `HonuaAgentToolCall`). |
| `ListSourcesArgs` | interface | keep | Tool-args type. |
| `ListCapabilitiesArgs` | interface | keep | Tool-args type. |
| `SetViewportArgs` | interface | keep | Tool-args type. |
| `AddLayerArgs` | interface | keep | Tool-args type. |
| `SetFilterArgs` | interface | keep | Tool-args type. |
| `SelectFeatureArgs` | interface | keep | Tool-args type. |
| `SummarizeSelectionArgs` | interface | keep | Tool-args type. |
| `RunWidgetQueryArgs` | interface | keep | Tool-args type. |
| `ExplainCapabilityGapArgs` | interface | keep | Tool-args type; also the input of `explainHonuaCapabilityGap` (MCP-used). |
| `HonuaAgentToolCall` | type | keep | NL import; discriminated tool-call union. |
| `HonuaAgentAuditEvent` | interface | keep | NL import; audit contract approval UIs consume. |
| `HonuaAgentToolResult` | interface | keep | NL import; executor result envelope. |
| `HonuaAgentToolExecutorOptions` | interface | keep | Executor policy options (allowlists, dry-run, audit hook). |
| `HonuaAiMapKitPolicy` | interface | keep | Kit policy (executor options + `readOnly`); documented product name. |
| `HonuaAgentContextOptions` | interface | keep | NL import; context/prompt bounding options. |
| `HonuaAgentSemanticMapContext` | interface | keep | Semantic map-context contract fed to LLMs. |
| `HonuaMcpCompatibleToolDefinition` | interface | keep | NL + MCP-format exporter output shape. |
| `HonuaOpenAiToolDefinition` | interface | keep | NL + OpenAI-format exporter output shape. |
| `HonuaProviderToolDefinition` | type | keep | Union of provider formats. |
| `HonuaAiMapKitOptions` | interface | keep | Kit factory options. |
| `HonuaAiMapKit` | interface | keep | Kit facade contract. |
| `HonuaControllerLike` | interface | keep | Structural controller-adapter input. |
| `HonuaGeneratedAppRuntimeLikeForAgents` | interface | keep | Structural generated-app-adapter input; verbose but precise. |
| `HonuaAgentToolError` | class | keep | Typed error with `code`/`tool`; catch-narrowing contract. |
| `getHonuaAgentToolDefinition` | function | keep | Definition lookup with typed unknown-tool error. |
| `createHonuaAiMapKit` | function | keep | Batteries-included facade (docs/ai-map-kit.md). |
| `normalizeAiMapKitPolicy` | function | keep | Kit-policy → executor-options normalization (read-only fencing). |
| `convertHonuaAgentToolDefinitions` | function | keep | Format-parameterized exporter. |
| `toHonuaMcpToolDefinitions` | function | keep | NL import; MCP tool projection. |
| `toHonuaOpenAiToolDefinitions` | function | keep | NL import; OpenAI tool projection. |
| `createHonuaAgentMapContext` | function | keep | Bounded, sanitized semantic map context. |
| `createHonuaAgentSystemPrompt` | function | keep | NL import; system-prompt projection. |
| `adaptHonuaControllerToAgentRuntime` | function | keep | Controller → runtime adapter. |
| `adaptHonuaGeneratedAppRuntimeToAgentRuntime` | function | keep | Generated-app → runtime adapter. |
| `createHonuaAgentToolExecutor` | function | keep | Curried executor factory. |
| `executeHonuaAgentTool` | function | keep | NL import; the bounded executor. |
| `explainHonuaCapabilityGap` | function | keep | MCP import (`mcp/src/tools/explain-capability-gap.ts`); NL import. |

### `/agent-safety` (62 symbols — all keep)

| Symbol | Kind | Disposition | Evidence / rationale |
|---|---|---|---|
| `AGENT_PLAN_KIND` | const | keep | NL import; envelope kind discriminant. |
| `AGENT_DRY_RUN_KIND` | const | keep | Envelope kind discriminant. |
| `AGENT_APPROVAL_KIND` | const | keep | Envelope kind discriminant. |
| `AGENT_RECEIPT_KIND` | const | keep | Envelope kind discriminant. |
| `AGENT_CONSUMPTION_KIND` | const | keep | Envelope kind discriminant (host replay stores mint these). |
| `AGENT_EXECUTION_AUDIT_KIND` | const | keep | Audit-event kind discriminant. |
| `AGENT_SAFETY_EVIDENCE_KIND` | const | keep | Derived-evidence kind discriminant. |
| `AGENT_SAFETY_VERSION` | const | keep | NL import; envelope version constant. |
| `AGENT_SAFETY_HARD_LIMITS` | const | keep | Published hard caps; hosts size policies against it. |
| `HonuaAgentSafetyError` | class | keep | Typed error with `AgentSafetyErrorCode`; catch-narrowing contract. |
| `HonuaAgentExecutionError` | class | keep | Execution error carrying the signed receipt for reconciliation. |
| `dryRunAgentPlan` | function | keep | NL import; validation + effect-budget entry point. |
| `digestAgentOperationInput` | function | keep | NL import; canonical operation identity. |
| `snapshotAgentExecutionInputs` | function | keep | Foreign-input snapshot for approved execution. |
| `verifyAgentStepAuthorization` | function | keep | Authorization + single-use consumption boundary. |
| `issueAgentApproval` | function | keep | NL import; approval signing. |
| `verifyAgentApproval` | function | keep | NL import; approval verification. |
| `issueAgentExecutionReceipt` | function | keep | Receipt signing. |
| `verifyAgentExecutionReceipt` | function | keep | Receipt verification. |
| `executeAgentPlanStep` | function | keep | The composed effect boundary; wrapped by MCP's read-only executor. |
| `deriveAgentSafetyEvidence` | function | keep | Accepted-plan/discovery evidence derivation (#468). |
| `verifyAgentSafetyEvidence` | function | keep | Evidence verification. |
| `DeriveAgentSafetyEvidenceOptions` | type | keep | Options for the above. |
| `AgentDigest` | type | keep | `sha256:` template-literal digest type used across envelopes. |
| `AgentEffect` | type | keep | NL import; effect vocabulary. |
| `AgentDataMode` | type | keep | Provenance data-mode vocabulary. |
| `AgentSafetyErrorCode` | type | keep | Error-code union for catch narrowing. |
| `AgentSafetyOptions` | type | keep | Common `now`/`signal`/`maxClockSkewMs` options. |
| `AgentSafetyUnavailableFact` | type | keep | Evidence unavailable-fact vocabulary. |
| `AgentSafetyEvidenceV1` | interface | keep | Derived-evidence envelope. |
| `AgentSafetyEvidenceProvenanceV1` | interface | keep | Evidence provenance shape. |
| `AgentCitationV1` | interface | keep | Credential-free citation shape. |
| `AgentProvenanceV1` | interface | keep | Source provenance shape. |
| `AgentSourceBindingV1` | interface | keep | NL import; source binding (schema/source versions, scopes). |
| `AgentQueryPlanBindingV1` | interface | keep | Query-plan id + fingerprint binding. |
| `AgentPlanStepV1` | interface | keep | NL import; plan-step envelope. |
| `AgentPlanV1` | interface | keep | NL import; plan envelope. |
| `AgentPlanPolicyV1` | interface | keep | NL import; policy envelope. |
| `AgentSourcePolicyV1` | interface | keep | Per-source policy shape. |
| `AgentEffectBudgetV1` | interface | keep | Dry-run effect budget. |
| `AgentDryRunV1` | interface | keep | NL import; dry-run envelope. |
| `AgentApprovalRequestV1` | interface | keep | Approval request (issuance input). |
| `AgentApprovedStepV1` | interface | keep | Approved per-step allocation. |
| `AgentApprovalV1` | interface | keep | NL import; signed approval envelope — the contract approval UIs build on. |
| `AgentApprovalUseConsumer` | interface | keep | Host atomic replay store contract. |
| `AgentApprovalConsumptionV1` | interface | keep | Authenticated consumption record. |
| `AgentExecutionContextV1` | interface | keep | NL import; current-source context. |
| `AgentExecutionEvidenceV1` | interface | keep | Outcome evidence (receipt input). |
| `AgentExecutionReceiptV1` | interface | keep | Signed execution receipt. |
| `AgentExecutionInputSnapshotV1` | interface | keep | Snapshot of all foreign execution inputs. |
| `AgentStepAuthorizationV1` | interface | keep | Authorization result envelope. |
| `AgentOperationInputV1` | interface | keep | MCP import (`mcp/src/agent-execution.ts`); exact operation input. |
| `AgentOperationExecutionResultV1` | interface | keep | MCP import; executor result contract. |
| `AgentOperationExecutorV1` | interface | keep | MCP import; host executor contract. |
| `AgentExecutionAuditV1` | type | keep | Audit-event union. |
| `AgentExecutionStartedAuditV1` | interface | keep | Start audit event. |
| `AgentExecutionCompletedAuditV1` | interface | keep | Completion audit event. |
| `AgentExecutionAuditSinkV1` | interface | keep | Durable audit sink contract. |
| `ExecuteAgentPlanStepOptions` | interface | keep | `executeAgentPlanStep` options. |
| `ExecutedAgentPlanStepV1` | interface | keep | `executeAgentPlanStep` result (value + receipt). |
| `AgentEnvelopeSigner` | interface | keep | NL import; host signer contract. |
| `AgentEnvelopeVerifier` | interface | keep | NL import; host verifier contract. |

## Consequences

- Breaking changes to any symbol above now require a major version; additive
  evolution continues in minors per the semver policy in INSTALL.md.
- `api-report/stable-api.json` gains both entrypoints (56 + 62 symbols); the
  `verify:api-report`, `verify:public-surface`, and `verify:bundle-budgets`
  gates now guard them.
- The experimental tier shrinks from 10 to 8 subpaths. `/nl-map-control`
  deliberately remains experimental: it is one release old and its plan
  contract may still move with eval feedback.
- MCP consumption was audited: `mcp/` imports only package subpath entrypoints
  (`@honua/sdk-js/agent-tools`, `@honua/sdk-js/agent-safety`) — no deep
  `dist/` or `src/` imports. One pre-existing type-only import of the
  experimental `@honua/sdk-js/query-planner` (`JsonValue`) remains; it has no
  runtime footprint and query-planner stabilization is a separate decision.
