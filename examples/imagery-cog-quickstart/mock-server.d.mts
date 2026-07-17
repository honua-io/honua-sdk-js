export interface ImageryCogFixtureServer {
  readonly url: string;
  close(): Promise<void>;
}

export function startImageryCogFixtureServer(options?: { readonly build?: boolean }): Promise<ImageryCogFixtureServer>;
