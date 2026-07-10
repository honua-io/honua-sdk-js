import {
  createProposal,
  createSafeAgentSession,
  describeHostLane,
  fixturePolicy,
  fixtureProposal,
} from "./safe-agent.js";
import type { AgentProposalV1, Decision, SafeAgentSession } from "./safe-agent.js";

import "./styles.css";

declare global {
  interface Window {
    __HONUA_SAFE_AGENT__?: {
      readonly ready: boolean;
      runHappyPath(decision?: Decision, narrowedMaxRows?: number): Promise<void>;
      runRefusal(kind: "mutation" | "realtime" | "excessive-limit" | "unsupported-tool"): void;
      reset(): void;
      readonly state: string;
      readonly executionCount: number;
    };
  }
}

let session = createSafeAgentSession();
const hostLane = describeHostLane();

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
      <div><dt>Source / schema</dt><dd>${escapeHtml(plan.queryPlan.ir.source.sourceVersion)} / ${escapeHtml(plan.queryPlan.ir.source.schemaVersion)}</dd></div>
      <div><dt>Authorization</dt><dd>${escapeHtml(plan.queryPlan.ir.source.authorizationScope.join(", "))}</dd></div>
      <div><dt>CRS / row limit</dt><dd>EPSG:${escapeHtml(plan.queryPlan.ir.query.outSr)} / ${escapeHtml(plan.queryPlan.ir.query.pagination?.limit)}</dd></div>
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
    ? `${approval.decision} · ${approval.approvedMaxRows} rows · ${approval.actor}`
    : "No approval grant exists";
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
  element("#receipt-integrity").textContent = receipt ? String(session.verifyReceipt(receipt)) : "not-run";
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

function decide(decision: Decision, maxRows?: number): void {
  session.decide(decision, maxRows);
  element("#event-log").textContent =
    decision === "reject"
      ? "Reviewer rejected the plan. Execution remains disabled."
      : `Reviewer ${decision}d a digest-bound read grant.`;
  render();
}

async function execute(): Promise<void> {
  try {
    const receipt = await session.execute();
    element("#event-log").textContent = `Executed one approved read and verified ${receipt.receiptDigest}.`;
  } catch (error) {
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

element("#validate").addEventListener("click", validate);
element("#approve").addEventListener("click", () => decide("approve"));
element("#narrow").addEventListener("click", () => decide("narrow", 2));
element("#reject").addEventListener("click", () => decide("reject"));
element("#execute").addEventListener("click", () => void execute());
element("#reset").addEventListener("click", () => reset());
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-refusal]")) {
  button.addEventListener("click", () => {
    reset(refusalProposal(button.dataset.refusal as "mutation" | "realtime" | "excessive-limit" | "unsupported-tool"));
    validate();
  });
}

window.__HONUA_SAFE_AGENT__ = {
  ready: true,
  async runHappyPath(decision: Decision = "approve", narrowedMaxRows?: number) {
    validate();
    decide(decision, narrowedMaxRows);
    if (decision !== "reject") await execute();
  },
  runRefusal(kind) {
    reset(refusalProposal(kind));
    validate();
  },
  reset,
  get state() {
    return session.state;
  },
  get executionCount() {
    return session.executionCount;
  },
};

render();
