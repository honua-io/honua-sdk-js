export declare const EVAL_SERVICE_ID: string;
export declare const EVAL_LAYER_ID: number;
export declare const EVAL_OGC_COLLECTION_ID: string;
export declare const EVAL_LOCATOR_NAME: string;

export interface EvalFixtureServer {
  url: string;
  requests: Array<{ method: string; pathname: string; search: string }>;
  close(): Promise<void>;
}

export declare function evaluateWhere(where: string | null | undefined, attributes: Record<string, unknown>): boolean;
export declare function startEvalFixtureServer(options: { repoRoot: string; port?: number }): Promise<EvalFixtureServer>;
