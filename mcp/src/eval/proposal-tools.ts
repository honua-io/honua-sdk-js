/**
 * The honua-server governed-proposal roster.
 *
 * The server retired the opaque `honua_propose_operation` escape hatch
 * (honua-server #3474/#3735) and replaced it with one typed tool per proposal
 * kind. Each one files a control-plane proposal for human approval; none of them
 * belongs in a read-only analysis or a north-star authoring workflow, so the
 * corpora forbid the whole roster where they used to forbid the single retired
 * name.
 */
export const TYPED_PROPOSAL_TOOLS = [
  "honua_propose_finding",
  "honua_propose_deploy_plan",
  "honua_propose_deploy_operation",
  "honua_propose_rollback",
  "honua_propose_platform_release_convergence",
  "honua_propose_metadata_release",
] as const;

/** The retired generic proposal tool. No catalog or corpus may name it. */
export const RETIRED_PROPOSAL_TOOL = "honua_propose_operation";
