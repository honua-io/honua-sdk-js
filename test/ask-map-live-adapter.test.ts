import { once } from "node:events";
import { createServer } from "node:http";
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
    const result = await complete(requestBody, new AbortController().signal);
    expect(result).toEqual({
      clarification: "Which location?",
      modelIdentity: { provider: "https://model.example", model: "fixture-model" },
    });
    expect(JSON.stringify(result)).not.toContain("test-server-model-key");
    const options = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ authorization: "Bearer test-server-model-key" });
    expect(String(options.body)).not.toContain("test-server-model-key");
    expect(() =>
      openAiCompatibleCompletion({ endpoint: "http://model.example", apiKey: "key", model: "model" }),
    ).toThrow();
  });
});
