import type { Server } from "node:http";

export interface PlanningWorkbenchFixtureServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export function startPlanningWorkbenchFixtureServer(options?: {
  readonly build?: boolean;
}): Promise<PlanningWorkbenchFixtureServer>;
