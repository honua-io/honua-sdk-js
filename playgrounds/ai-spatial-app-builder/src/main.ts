import {
  createProposal,
  createSafeAgentSession,
  describeHostLane,
  fixturePolicy,
  fixtureProposal,
} from "./safe-agent.js";
import type { AgentProposalV1, Decision } from "./safe-agent.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_SAFE_AGENT__?: {
      readonly ready: boolean;
      readonly disposed: boolean;
      runHappyPath(decision?: Decision, narrowedMaxRows?: number): Promise<void>;
      runRefusal(kind: "mutation" | "realtime" | "excessive-limit" | "unsupported-tool"): void;
      reset(): void;
      dispose(): void;
      readonly state: string;
      readonly executionCount: number;
    };
  }
}

let session = createSafeAgentSession();
const hostLane = describeHostLane();
let disposed = false;
const uiEvents = new AbortController();
const uiEventOptions = { signal: uiEvents.signal };

function element<T extends Element>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing required element: ${selector}`);
  return match;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(): void {
  if (disposed) return;
  element("#state-value").textContent = session.state;
  element("#effect-count").textContent = String(session.executionCount);
  element("#live-status").textContent = hostLane.state;
  element("#live-detail").textContent =
    hostLane.reason ?? "Host-mediated endpoints available; credentials remain server-side.";
  renderProposal();
  renderPlan();
  renderApproval();
  renderReceipt();
  renderResults();
}

function renderProposal(): void {
  const proposal = session.proposal;
  element("#proposal-origin").textContent = proposal.origin;
  element("#proposal-effect").textContent = proposal.requestedEffect;
  element("#proposal-prompt").textContent = proposal.prompt;
  element("#tool-calls").innerHTML = proposal.toolCalls
    .map(
      (tool) =>
        `<li><code>${escapeHtml(tool.name)}</code><span>${escapeHtml(tool.effect)}</span><p>${escapeHtml(tool.reason)}</p></li>`,
    )
    .join("");
}

function renderPlan(): void {
  const plan = session.validatedPlan;
  const panel = element<HTMLElement>("#plan-panel");
  if (!plan) {
    panel.dataset.state = "pending";
    element("#plan-state").textContent = "Waiting for policy validation";
    element("#plan-details").innerHTML = "";
    return;
  }
  panel.dataset.state = plan.valid ? "valid" : "refused";
  element("#plan-state").textContent = plan.valid ? "Validated — no effects occurred" : "Refused before execution";
  element("#plan-details").innerHTML = `
    <dl class="binding-grid">
      <div><dt>Plan fingerprint</dt><dd><code>${escapeHtml(plan.queryPlan.fingerprint)}</code></dd></div>
      <div><dt>Approval digest</dt><dd><code>${escapeHtml(plan.approvalDigest)}</code></dd></div>
      <div><dt>Shared safety envelope</dt><dd>${escapeHtml(plan.dryRun?.kind ?? "not-issued")} · ${escapeHtml(plan.dryRun?.effectBudget.rows ?? 0)} rows / ${escapeHtml(plan.dryRun?.effectBudget.bytes ?? 0)} bytes</dd></div>
      <div><dt>Policy / bindings digest</dt><dd><code>${escapeHtml(plan.dryRun?.policyDigest ?? "-")} / ${escapeHtml(plan.dryRun?.bindingsDigest ?? "-")}</code></dd></div>
      <div><dt>Source / schema</dt><dd>${escapeHtml(plan.queryPlan.ir.source.sourceVersion)} / ${escapeHtml(plan.queryPlan.ir.source.schemaVersion)}</dd></div>
      <div><dt>Authorization</dt><dd>${escapeHtml(plan.queryPlan.ir.source.authorizationScope.join(", "))}</dd></div>
      <div><dt>CRS / row limit</dt><dd>EPSG:${escapeHtml(plan.queryPlan.ir.query.outSr)} / ${escapeHtml(plan.queryPlan.ir.query.pagination?.limit)}</dd></div>
      <div><dt>Request / row / byte estimate</dt><dd>${escapeHtml(plan.queryPlan.estimates.requests ?? "unknown")} / ${escapeHtml(plan.queryPlan.estimates.rows ?? "unknown")} / ${escapeHtml(plan.queryPlan.estimates.bytes ?? "unknown")} bytes</dd></div>
      <div><dt>Approved byte ceiling</dt><dd>${escapeHtml(plan.policy.maxBytes)} bytes</dd></div>
      <div><dt>Fidelity / cache</dt><dd>${escapeHtml(plan.queryPlan.fidelity)} / ${escapeHtml(plan.queryPlan.cache.action)}</dd></div>
      <div><dt>Data provenance</dt><dd>${escapeHtml(plan.sourceProvenance.dataMode)} · observed ${escapeHtml(plan.sourceProvenance.observedAt)} · ${escapeHtml(plan.sourceProvenance.attribution)}</dd></div>
      <div><dt>Capabilities</dt><dd>${escapeHtml(plan.queryPlan.ir.source.capabilities.join(", "))}</dd></div>
      <div><dt>Policy</dt><dd>${escapeHtml(plan.policy.id)} · ${escapeHtml(plan.policy.allowedEffects.join(", "))}</dd></div>
      <div><dt>Compiled step</dt><dd>${escapeHtml(plan.queryPlan.steps.map((step) => `${step.engine}:${step.operation}`).join(" → "))}</dd></div>
    </dl>
    <div class="refusal-list" ${plan.refusals.length ? "" : "hidden"}>
      <h3>Why this proposal was refused</h3>
      <ul>${plan.refusals.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    </div>`;
}

function renderApproval(): void {
  const approval = session.approval;
  element("#approval-state").textContent = approval
    ? `${approval.decision} · ${approval.approvedMaxRows} rows · ${approval.approvedMaxBytes} bytes · ${approval.grant ? `${approval.grant.algorithm}/${approval.grant.keyId} · single use · expires ${approval.grant.expiresAt}` : "no grant issued"}`
    : "No approval grant exists";
  const executing = session.state === "executing";
  element<HTMLButtonElement>("#validate").disabled = executing;
  element<HTMLButtonElement>("#reset").textContent = executing ? "Cancel & reset fixture" : "Reset fixture";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-refusal]")) button.disabled = executing;
  element<HTMLButtonElement>("#approve").disabled = session.state !== "validated";
  element<HTMLButtonElement>("#narrow").disabled = session.state !== "validated";
  element<HTMLButtonElement>("#reject").disabled = session.state !== "validated";
  element<HTMLButtonElement>("#execute").disabled = session.state !== "approved";
}

function renderReceipt(): void {
  const receipt = session.receipt;
  element("#receipt-state").textContent = receipt ? "Verified tamper-evident receipt" : "No execution receipt";
  element("#receipt-json").textContent = receipt
    ? JSON.stringify(receipt, null, 2)
    : "Execution is intentionally unavailable before approval.";
  element("#receipt-integrity").textContent = receipt ? String(session.receiptVerified) : "not-run";
}

function renderResults(): void {
  element("#row-count").textContent = String(session.rows.length);
  element("#result-rows").innerHTML = session.rows
    .map(
      (row) =>
        `<tr><td>${row.OBJECTID}</td><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.floodZone)}</td><td>${row.builtYear}</td><td>$${Math.round(row.assessedValue / 1000)}k</td></tr>`,
    )
    .join("");
}

function reset(proposal: AgentProposalV1 = fixtureProposal): void {
  if (disposed) return;
  session.dispose();
  session = createSafeAgentSession(proposal, fixturePolicy);
  element("#event-log").textContent = "Proposal loaded. No source or tool effect has run.";
  render();
}

function validate(): void {
  session.validate();
  element("#event-log").textContent = session.validatedPlan?.valid
    ? "Policy and planner validation passed. Source reads remain at zero."
    : `Refused: ${session.validatedPlan?.refusals.join(" ")}`;
  render();
}

async function decide(decision: Decision, maxRows?: number): Promise<void> {
  await session.decide(decision, maxRows);
  element("#event-log").textContent =
    decision === "reject"
      ? "Reviewer rejected the plan. Execution remains disabled."
      : `Reviewer ${decision}d a digest-bound read grant.`;
  render();
}

async function execute(): Promise<void> {
  if (disposed) return;
  const activeSession = session;
  const execution = activeSession.execute();
  render();
  try {
    const receipt = await execution;
    if (disposed || session !== activeSession) return;
    element("#event-log").textContent = `Executed one approved read and verified ${receipt.receiptDigest}.`;
  } catch (error) {
    if (disposed || session !== activeSession) return;
    element("#event-log").textContent = `Execution refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}

function refusalProposal(kind: "mutation" | "realtime" | "excessive-limit" | "unsupported-tool"): AgentProposalV1 {
  if (kind === "excessive-limit")
    return createProposal({ id: "proposal-excess", query: { ...fixtureProposal.query, pagination: { limit: 500 } } });
  if (kind === "unsupported-tool") {
    return createProposal({
      id: "proposal-publish",
      toolCalls: [{ name: "publishLayer", effect: "generated-app", reason: "Attempt a generated-app effect." }],
    });
  }
  return createProposal({
    id: `proposal-${kind}`,
    requestedEffect: kind,
    toolCalls: [
      {
        name: kind === "mutation" ? "applyEdits" : "subscribe",
        effect: kind,
        reason: "Requires separate host policy.",
      },
    ],
  });
}

element("#validate").addEventListener("click", validate, uiEventOptions);
element("#approve").addEventListener("click", () => void decide("approve"), uiEventOptions);
element("#narrow").addEventListener("click", () => void decide("narrow", 2), uiEventOptions);
element("#reject").addEventListener("click", () => void decide("reject"), uiEventOptions);
element("#execute").addEventListener("click", () => void execute(), uiEventOptions);
element("#reset").addEventListener("click", () => reset(), uiEventOptions);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-refusal]")) {
  button.addEventListener(
    "click",
    () => {
      reset(
        refusalProposal(button.dataset.refusal as "mutation" | "realtime" | "excessive-limit" | "unsupported-tool"),
      );
      validate();
    },
    uiEventOptions,
  );
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  uiEvents.abort();
  session.dispose();
}

window.__HONUA_SAFE_AGENT__ = {
  get ready() {
    return !disposed;
  },
  get disposed() {
    return disposed;
  },
  async runHappyPath(decision: Decision = "approve", narrowedMaxRows?: number) {
    if (disposed) return;
    validate();
    await decide(decision, narrowedMaxRows);
    if (decision !== "reject") await execute();
  },
  runRefusal(kind) {
    if (disposed) return;
    reset(refusalProposal(kind));
    validate();
  },
  reset,
  dispose,
  get state() {
    return session.state;
  },
  get executionCount() {
    return session.executionCount;
  },
};

window.addEventListener("beforeunload", dispose, { once: true, signal: uiEvents.signal });

render();
