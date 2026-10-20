import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { McpClient } from "@honua/sdk-js/studio-agent";
import { describe, expect, it } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("McpClient resource windows", () => {
  it("retains continuation results and sends the next window with fresh authority", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = [];
    const uri = "honua://catalog/processes";
    let token = "first-fixture-token";
    const client = new McpClient({
      baseUrl: "https://fixture.invalid",
      auth: { getAccessToken: async () => token },
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        calls.push({ method: request.method, params: request.params, headers: new Headers(init?.headers) });
        const result =
          request.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {} }
            : request.params.cursor
              ? { contents: [{ uri, text: '"last"}]}' }] }
              : { contents: [{ uri, text: '{"processes":[{"processId":' }], nextCursor: "opaque-window:64,000" };
        return Response.json(
          { jsonrpc: "2.0", id: request.id, result },
          {
            headers: { "mcp-session-id": "fixture-session" },
          },
        );
      },
    });
    const first = await client.readResource(uri);
    expect(first.nextCursor).toBe("opaque-window:64,000");
    expect(calls.at(-1)?.params).toEqual({ uri });
    token = "second-fixture-token";
    const last = await client.readResource(uri, { cursor: first.nextCursor ?? undefined, maxChars: 1_000_000 });
    expect(last.nextCursor).toBeUndefined();
    expect(calls.at(-1)?.params).toEqual({ uri, cursor: "opaque-window:64,000", maxChars: 1_000_000 });
    expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer second-fixture-token");
    expect(calls.at(-1)?.headers.get("mcp-session-id")).toBe("fixture-session");
    expect(calls.map((call) => call.method)).toEqual(["initialize", "resources/read", "resources/read"]);
    expect(JSON.parse(String(first.contents?.[0].text) + String(last.contents?.[0].text))).toEqual({
      processes: [{ processId: "last" }],
    });
  });

  it("passes cancellation to a resource request after initialization", async () => {
    const controller = new AbortController();
    let resourceSignal: AbortSignal | null | undefined;
    const client = new McpClient({
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } });
        }
        resourceSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          queueMicrotask(() => controller.abort(new Error("Cancelled resource read")));
        });
      },
    });
    await expect(client.readResource("honua://catalog/processes", { signal: controller.signal })).rejects.toThrow(
      "Could not reach the MCP endpoint",
    );
    expect(resourceSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(true);
  });

  it("refuses an already cancelled read without starting initialization", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before initialization"));
    const methods: string[] = [];
    const client = new McpClient({
      fetchImpl: async (_input, init) => {
        methods.push(JSON.parse(String(init?.body)).method);
        init?.signal?.throwIfAborted();
        throw new Error("Expected an aborted initialization");
      },
    });
    await expect(client.readResource("honua://catalog/processes", { signal: controller.signal })).rejects.toThrow(
      "Could not reach the MCP endpoint",
    );
    expect(methods).toEqual([]);
  });

  it.each([0, 1])("cancels waiter %s without aborting another read's shared initialization", async (cancelledIndex) => {
    const controllers = [new AbortController(), new AbortController()];
    const initialized = deferred<Response>();
    const started = deferred<void>();
    const methods: string[] = [];
    let handshakeSignal: AbortSignal | null | undefined;
    const client = new McpClient({
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        methods.push(request.method);
        if (request.method === "initialize") {
          handshakeSignal = init?.signal;
          init?.signal?.addEventListener("abort", () => initialized.reject(init.signal?.reason), { once: true });
          started.resolve();
          return initialized.promise;
        }
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { contents: [] } });
      },
    });
    const reads = controllers.map((controller) =>
      client.readResource("honua://catalog/processes", { signal: controller.signal }),
    );
    const refused = expect(reads[cancelledIndex]).rejects.toThrow("Could not reach the MCP endpoint");
    await started.promise;
    controllers[cancelledIndex].abort(new Error("Cancelled one waiter"));
    await refused;
    expect(handshakeSignal?.aborted).toBe(false);
    expect(methods).toEqual(["initialize"]);

    initialized.resolve(Response.json({ jsonrpc: "2.0", id: "initialize", result: { protocolVersion: "2025-03-26" } }));
    await expect(reads[1 - cancelledIndex]).resolves.toEqual({ contents: [] });
    expect(methods).toEqual(["initialize", "resources/read"]);
  });

  it("aborts an abandoned handshake and starts a fresh one for a later read", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let handshakes = 0;
    let abandonedSignal: AbortSignal | null | undefined;
    const client = new McpClient({
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "initialize" && ++handshakes === 1) {
          abandonedSignal = init?.signal;
          started.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "initialize" ? { protocolVersion: "2025-03-26" } : { contents: [] },
        });
      },
    });
    const read = client.readResource("honua://catalog/processes", { signal: controller.signal });
    const refused = expect(read).rejects.toThrow("Could not reach the MCP endpoint");
    await started.promise;
    controller.abort();
    await refused;
    expect(abandonedSignal?.aborted).toBe(true);
    await expect(client.readResource("honua://catalog/processes")).resolves.toEqual({ contents: [] });
    expect(handshakes).toBe(2);
  });

  it("ignores a late reset handshake without clearing the fresh handshake or restoring its identity", async () => {
    const oldResponse = deferred<Response>();
    const freshResponse = deferred<Response>();
    const oldStarted = deferred<void>();
    const freshStarted = deferred<void>();
    const resourceSessions: Array<string | null> = [];
    let handshakes = 0;
    let oldSignal: AbortSignal | null | undefined;
    const client = new McpClient({
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "initialize") {
          handshakes += 1;
          if (handshakes === 1) {
            oldSignal = init?.signal;
            oldStarted.resolve();
            // Deliberately ignore cancellation to exercise a late network response.
            return oldResponse.promise;
          }
          if (handshakes === 2) {
            freshStarted.resolve();
            return freshResponse.promise;
          }
          throw new Error("The fresh handshake must remain shared");
        }
        resourceSessions.push(new Headers(init?.headers).get("mcp-session-id"));
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { contents: [] } });
      },
    });
    const abandoned = client.readResource("honua://catalog/processes");
    const refused = expect(abandoned).rejects.toThrow("Could not reach the MCP endpoint");
    await oldStarted.promise;
    client.resetSession();
    await refused;
    expect(oldSignal?.aborted).toBe(true);

    const fresh = client.readResource("honua://catalog/processes");
    await freshStarted.promise;
    oldResponse.resolve(
      Response.json(
        { jsonrpc: "2.0", id: "old-initialize", result: { protocolVersion: "2025-03-26" } },
        { headers: { "mcp-session-id": "old-session" } },
      ),
    );
    // Drain the released response's promise chain, including its stale finalizer.
    await nextEventLoopTurn();
    expect(client.sessionId).toBeUndefined();
    expect(client.serverInfo).toBeUndefined();

    const joined = client.readResource("honua://catalog/processes");
    expect(handshakes).toBe(2);
    freshResponse.resolve(
      Response.json(
        { jsonrpc: "2.0", id: "fresh-initialize", result: { protocolVersion: "2025-03-26" } },
        { headers: { "mcp-session-id": "fresh-session" } },
      ),
    );
    await expect(Promise.all([fresh, joined])).resolves.toEqual([{ contents: [] }, { contents: [] }]);
    expect(client.sessionId).toBe("fresh-session");
    expect(resourceSessions).toEqual(["fresh-session", "fresh-session"]);
    expect(handshakes).toBe(2);
  });
});
