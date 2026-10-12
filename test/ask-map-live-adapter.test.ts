import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createLiveModelHandler, openAiCompatibleCompletion } from "../examples/nl-map-control/live-adapter.mjs";
import type { NlCompletionRequest } from "../src/nl-map-control/index.js";

const requestBody: NlCompletionRequest = {
  purpose: "propose",
  attempt: 1,
  instruction: "Show open incidents",
  system: "Public fixture schema",
  messages: [{ role: "user", content: "Show open incidents" }],
  tools: [{ name: "runWidgetQuery", description: "Read", inputSchema: { type: "object" } }],
};
describe("Authenticated server-side model adapter", () => {
  it("bounds authentication and non-cooperative providers, and sanitizes authentication exceptions", async () => {
    for (const scenario of ["authentication-hangs", "provider-hangs", "authentication-throws"]) {
      const complete = vi.fn(() => new Promise<never>(() => {}));
      const handler = createLiveModelHandler({
        origin: "https://app.example",
        timeoutMs: 50,
        complete,
        authenticate: () => {
          if (scenario === "authentication-hangs") return new Promise<boolean>(() => {});
          if (scenario === "authentication-throws") throw new Error("private-auth-service-detail");
          return true;
        },
      });
      const server = createServer(handler);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bind failed");
      try {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${address.port}/api/ask-map/propose`, {
          method: "POST",
          headers: { origin: "https://app.example", "content-type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(1500),
        });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(response.status).toBe(scenario === "authentication-throws" ? 502 : 504);
        expect(await response.json()).toEqual({ error: "model-request-failed" });
        expect(complete).toHaveBeenCalledTimes(scenario === "provider-hangs" ? 1 : 0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
  it("terminates a slow request body before calling a provider that ignores cancellation", async () => {
    const complete = vi.fn(() => new Promise<never>(() => {}));
    const server = createServer(
      createLiveModelHandler({
        origin: "https://app.example",
        authenticate: () => true,
        complete,
        timeoutMs: 50,
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const started = performance.now();
    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${address.port}/api/ask-map/propose`, {
          method: "POST",
          headers: { origin: "https://app.example", "content-type": "application/json" },
        });
        const deadline = setTimeout(() => {
          request.destroy();
          reject(new Error("Adapter failed to bound upload"));
        }, 1500);
        request.once("error", () => {
          clearTimeout(deadline);
          resolve("connection-closed");
        });
        request.once("response", (response) => {
          clearTimeout(deadline);
          response.resume();
          resolve(String(response.statusCode));
        });
        request.write("{"); // Deliberately never finish the body.
      });
      expect(["connection-closed", "504"]).toContain(outcome);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("requires both authenticated session and same origin before touching the provider", async () => {
    const complete = vi.fn(async () => ({ refusal: "No date field" }));
    const server = createServer(
      createLiveModelHandler({
        origin: "https://app.example",
        authenticate: (request) => request.headers.cookie === "session=authenticated",
        complete,
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bind failed");
    const url = `http://127.0.0.1:${address.port}/api/ask-map/propose`;
    try {
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { origin: "https://evil.example", cookie: "session=authenticated" },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { origin: "https://app.example" } })).status).toBe(401);
      expect(complete).not.toHaveBeenCalled();
      const result = await fetch(url, {
        method: "POST",
        headers: { origin: "https://app.example", cookie: "session=authenticated", "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ refusal: "No date field" });
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: {
              origin: "https://app.example",
              cookie: "session=authenticated",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...requestBody, attempt: 4 }),
          })
        ).status,
      ).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("passes credentials only to the fixed HTTPS provider and returns only callback data", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "fixture-model",
            choices: [
              {
                message: {
                  tool_calls: [
                    { function: { name: "clarify", arguments: JSON.stringify({ question: "Which location?" }) } },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const complete = openAiCompatibleCompletion({
      endpoint: "https://model.example/chat/completions",
      apiKey: "test-server-model-key",
      model: "fixture-model",
      fetchImpl,
    });
    const correction = {
      previousToolCalls: [{ name: "runWidgetQuery", arguments: { semanticQuery: "{}" } }],
      issues: [{ code: "invalid-arguments", message: "semanticQuery must be an object" }],
    };
    const result = await complete(
      { ...requestBody, purpose: "self-correct", attempt: 2, correction },
      new AbortController().signal,
    );
    expect(result).toEqual({
      clarification: "Which location?",
      modelIdentity: { provider: "https://model.example", model: "fixture-model" },
    });
    expect(JSON.stringify(result)).not.toContain("test-server-model-key");
    const options = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ authorization: "Bearer test-server-model-key" });
    expect(String(options.body)).not.toContain("test-server-model-key");
    const sent = JSON.parse(String(options.body));
    expect(sent.messages.at(-1).role).toBe("user");
    expect(sent.messages.at(-1).content).toContain("REJECTED and NEVER EXECUTED");
    expect(sent.messages.at(-1).content).toContain("do not change the accepted context.previousQuery");
    expect(sent.messages.at(-1).content).toContain(requestBody.instruction);
    expect(sent.messages.at(-1).content).toContain(JSON.stringify(correction));
    expect(() =>
      openAiCompatibleCompletion({ endpoint: "http://model.example", apiKey: "key", model: "model" }),
    ).toThrow();
  });
});
