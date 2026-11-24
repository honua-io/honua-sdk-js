export interface StaticRangeRequest {
  readonly method: string | undefined;
  readonly path: string;
  readonly range: string | null;
  status: number;
  bytes: number;
}

export interface StaticRangeServer {
  readonly origin: string;
  readonly requests: StaticRangeRequest[];
  bytesSent(pathname?: string): number;
  close(): Promise<void>;
}

export function startStaticRangeServer(options: {
  readonly files: Readonly<Record<string, string>>;
  readonly delayMs?: number;
  readonly cors?: boolean;
  readonly cacheControl?: string;
  readonly rangeSupport?: "full" | "get-only" | "none";
}): Promise<StaticRangeServer>;
