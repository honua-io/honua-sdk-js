import type { Server } from "node:http";

export interface ServiceExplorerFixtureServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export function startServiceExplorerFixtureServer(options?: {
  readonly build?: boolean;
}): Promise<ServiceExplorerFixtureServer>;
