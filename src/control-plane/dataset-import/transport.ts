import type { DatasetImportTaskClientOptions } from "./client.js";
import { DatasetImportTaskApiError } from "./errors.js";

/** Internal common transport: fixed deployment/workspace/turn, fresh authentication only. */
export class DatasetImportWorkspaceTransport {
  private readonly base: string;
  private readonly workspaceId: string;
  private readonly originatingTurnId?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers?: DatasetImportTaskClientOptions["headers"];

  constructor(options: DatasetImportTaskClientOptions) {
    const base = new URL(options.baseUrl);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new TypeError("A deployment HTTP(S) URL without credentials, query or fragment is required.");
    validId(options.workspaceId);
    validId(options.targetId);
    if (options.originatingTurnId !== undefined) validId(options.originatingTurnId);
    this.base = `${base.href.replace(/\/$/, "")}/api/v1/agent/workspaces/${encodeURIComponent(options.workspaceId)}`;
    this.workspaceId = options.workspaceId;
    this.originatingTurnId = options.originatingTurnId;
    // Native browser fetch rejects a transport instance as its receiver.
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers;
  }

  async request<T>(
    suffix: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: BodyInit | undefined,
    signal?: AbortSignal,
    allowMissing?: false,
    contentType?: string,
  ): Promise<T>;
  async request<T>(
    suffix: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    allowMissing: true,
    contentType?: string,
  ): Promise<T | null>;
  async request<T>(
    suffix: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    allowMissing = false,
    contentType = "application/json",
  ): Promise<T | null> {
    const headers = new Headers(await this.headers?.());
    headers.set("Accept", "application/json");
    headers.delete("X-Honua-Workspace");
    headers.delete("X-Honua-Turn");
    if (this.originatingTurnId !== undefined) {
      headers.set("X-Honua-Workspace", this.workspaceId);
      headers.set("X-Honua-Turn", this.originatingTurnId);
    }
    if (body !== undefined) headers.set("Content-Type", contentType);
    const response = await this.fetcher(`${this.base}${suffix}`, { method, headers, body, signal, redirect: "error" });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new DatasetImportTaskApiError(response.status);
    return (await response.json()) as T;
  }
}

export function validId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    throw new TypeError("A bounded canonical identity is required.");
}
