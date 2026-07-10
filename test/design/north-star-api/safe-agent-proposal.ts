import { createHonua } from "./contracts.js";
import type { AgentHost, ExecutionReceipt } from "./contracts.js";

/** Golden workflow 3: agent proposals cannot execute without a host-issued grant. */
export async function safeAgentProposal(host: AgentHost): Promise<ExecutionReceipt | undefined> {
  const honua = createHonua();
  const incidents = await honua.connect("https://demo.honua.io/ogc/features/collections/incidents");
  const proposal = await host.planner.propose("Show unresolved incidents near hospitals and summarize by severity", {
    connections: [incidents],
    policy: { allow: ["data:read", "map:write"], deny: ["data:write", "publish"] },
  });
  const preview = await proposal.dryRun();
  if (false) {
    // @ts-expect-error Agent proposals require a host-issued, plan-bound approval grant.
    await proposal.execute();
  }
  const approval = preview.allowed ? await host.requestApproval(proposal.approval) : undefined;
  const result = approval ? await proposal.execute({ approval }) : undefined;
  await honua.dispose();
  return result;
}
