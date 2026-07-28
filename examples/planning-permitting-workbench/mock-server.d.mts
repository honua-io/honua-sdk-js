import type { Server } from "node:http";

export interface PlanningWorkbenchFixtureServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export function startPlanningWorkbenchFixtureServer(options?: {
  readonly build?: boolean;
  readonly metadataMode?: "complete" | "missing-fields";
}): Promise<PlanningWorkbenchFixtureServer>;
