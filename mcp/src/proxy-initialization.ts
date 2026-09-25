import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InitializeRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const WORKFLOW_VIEW_META_KEY = "honua.io/workflow-view";
const MAX_BUFFERED_MESSAGES = 16;
const MAX_BUFFERED_BYTES = 64 * 1024;
const INITIALIZATION_TIMEOUT_MS = 30_000;

/** Match the server's optional selector contract, without forwarding other metadata. */
export function readWorkflowView(message: JSONRPCMessage): string | undefined {
  const request = InitializeRequestSchema.parse(message);
  const value = request.params._meta?.[WORKFLOW_VIEW_META_KEY];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 64) throw new Error("Invalid workflow view selector");
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Start stdio once, retaining the actual initialize until the upstream session
 * exists. The SDK Server then handles the original downstream lifecycle. This
 * is not a fabricated initialize or an upstream session-id supplied by a client.
 */
export class DeferredInitializationTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private readonly buffered: Parameters<NonNullable<Transport["onmessage"]>>[] = [];
  private bufferedBytes = 0;
  private initialized = false;
  private attached = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveView?: (view: string | undefined) => void;
  private rejectView?: (error: Error) => void;

  constructor(private readonly downstream: Transport) {
    downstream.onmessage = (...args) => this.receive(...args);
    downstream.onerror = () => this.fail(new Error("Downstream transport failed"));
    downstream.onclose = () => {
      this.closed = true;
      clearTimeout(this.timer);
      this.rejectView?.(new Error("Downstream closed during initialization"));
      this.onclose?.();
    };
  }

  async waitForInitialize(): Promise<string | undefined> {
    const view = new Promise<string | undefined>((resolve, reject) => {
      this.resolveView = resolve;
      this.rejectView = reject;
    });
    this.timer = setTimeout(() => this.fail(new Error("Proxy initialization timed out")), INITIALIZATION_TIMEOUT_MS);
    try {
      await this.downstream.start();
    } catch {
      this.fail(new Error("Downstream transport could not start"));
    }
    const selected = await view;
    if (this.closed) throw new Error("Proxy initialization is not available");
    return selected;
  }

  private receive(...args: Parameters<NonNullable<Transport["onmessage"]>>): void {
    if (this.closed) return;
    const [message] = args;
    const isInitialize = "method" in message && message.method === "initialize";
    if (isInitialize && this.initialized) {
      this.fail(new Error("Duplicate initialize is not permitted"), message);
      return;
    }
    if (!this.initialized) {
      try {
        if (!isInitialize || !("id" in message)) throw new Error("Initialize must be the first request");
        const view = readWorkflowView(message);
        this.initialized = true;
        this.resolveView?.(view);
      } catch {
        this.fail(new Error("Invalid initialize request or workflow view selector"), message);
        return;
      }
    }
    if (this.attached) {
      this.onmessage?.(...args);
      return;
    }
    this.bufferedBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
    if (this.buffered.length >= MAX_BUFFERED_MESSAGES || this.bufferedBytes > MAX_BUFFERED_BYTES) {
      this.fail(new Error("Proxy initialization buffer exceeded"), message);
      return;
    }
    this.buffered.push(args);
  }

  private fail(error: Error, message?: JSONRPCMessage): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.buffered.length = 0;
    this.rejectView?.(error);
    this.onerror?.(error);
    const reply =
      message && "id" in message
        ? this.downstream.send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: error.message } })
        : Promise.resolve();
    void reply
      .catch(() => {})
      .finally(() => this.downstream.close())
      .catch(() => {});
  }

  async start(): Promise<void> {
    if (this.closed || !this.initialized || this.attached) throw new Error("Proxy initialization is not available");
    this.attached = true;
    clearTimeout(this.timer);
    for (const args of this.buffered.splice(0)) this.onmessage?.(...args);
    this.bufferedBytes = 0;
  }

  async send(...args: Parameters<Transport["send"]>): Promise<void> {
    if (this.closed) throw new Error("Proxy transport is closed");
    return this.downstream.send(...args);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.buffered.length = 0;
    await this.downstream.close();
  }
}
