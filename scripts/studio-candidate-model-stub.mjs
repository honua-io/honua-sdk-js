// Scripted OpenAI-compatible provider for scripts/qualify-studio-candidate.mjs.
//
// It stands in for the model behind honua-server's Studio AI proxy so the
// qualification can observe the exact upstream request the proxy sends (the
// tool definitions a real model would receive) and drive a terminal
// StudioAgentSession through a fixed tool plan. It never decides anything from
// the tool descriptors: each round plays the next planned call, filling
// `$<tool>.<field>` placeholders from the values the server returned to the
// named earlier tool call (the last occurrence of the field in that result).
// It is a test double for the provider only; the server, proxy, SDK session
// and MCP dispatch under test are all real.
import { createServer } from "node:http";

const captured = [];
let plan = [];

function collectValues(value, into) {
  if (Array.isArray(value)) {
    for (const entry of value) collectValues(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" || typeof entry === "number") into[key] = entry;
      collectValues(entry, into);
    }
  }
  return into;
}

function resolvePlaceholders(value, values) {
  if (typeof value === "string" && value.startsWith("$")) {
    const [tool, field] = value.slice(1).split(".");
    const resolved = values[tool]?.[field];
    if (resolved === undefined) throw new Error(`no earlier tool result carried ${value}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => resolvePlaceholders(entry, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolvePlaceholders(entry, values)]));
  }
  return value;
}

function frame(response, payload) {
  response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/captured") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(captured));
      return;
    }
    if (request.method === "PUT" && request.url === "/plan") {
      plan = JSON.parse(await readBody(request));
      captured.length = 0;
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request));
    captured.push({ receivedAt: new Date().toISOString(), authorization: Boolean(request.headers.authorization), body });
    const results = body.messages.filter((message) => message.role === "tool");
    const toolNames = new Map();
    for (const message of body.messages) {
      for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name);
    }
    // A provider rejects a tool result that answers no assistant tool call; record any the proxy forwarded.
    captured.at(-1).orphanToolResults = results.filter((result) => !toolNames.has(result.tool_call_id)).map((result) => result.tool_call_id);
    const values = {};
    for (const result of results) {
      const name = toolNames.get(result.tool_call_id);
      if (!name) continue;
      try {
        values[name] = collectValues(JSON.parse(result.content), values[name] ?? {});
      } catch {
        // A non-JSON tool result carries no placeholder values.
      }
    }
    const base = { id: `chatcmpl-${captured.length}`, object: "chat.completion.chunk", model: body.model };
    const step = plan[results.length];
    let text;
    let args;
    if (step) {
      const advertised = (body.tools ?? []).some((tool) => tool.function?.name === step.tool);
      if (!advertised) {
        text = `planned tool ${step.tool} was not advertised to the model`;
      } else {
        try {
          args = JSON.stringify(resolvePlaceholders(step.args ?? {}, values));
        } catch (error) {
          // Answer with a terminal text turn instead of a broken stream, and keep why for the receipt.
          text = `plan step ${results.length} (${step.tool}) could not be filled: ${error.message}`;
          captured.at(-1).planError = { step: results.length, tool: step.tool, message: error.message, toolResults: values };
        }
      }
    } else {
      text = "Plan complete.";
    }
    // Headers go out only once the round's content is known, so every response is a complete stream.
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    if (args !== undefined) {
      frame(response, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: `call_${results.length}`, type: "function", function: { name: step.tool, arguments: args } },
      ] } }] });
      frame(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    if (text !== undefined) {
      frame(response, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] });
      frame(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    frame(response, { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    frame(response, "[DONE]");
    response.end();
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
    response.end(String(error?.stack ?? error));
  }
}).listen(8080);
