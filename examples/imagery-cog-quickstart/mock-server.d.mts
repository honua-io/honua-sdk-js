export interface ImageryCogFixtureServer {
  readonly url: string;
  close(): Promise<{
    readonly closed: true;
    readonly listeningAfterClose: boolean;
    readonly activeConnectionsAfterClose: number;
  }>;
}

export function startImageryCogFixtureServer(options?: { readonly build?: boolean }): Promise<ImageryCogFixtureServer>;
