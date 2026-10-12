import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HonuaCommandReceipt,
  createHonuaCommandRuntime,
  honuaCommandReceiptProjection,
  studioDraftSaveVersionCommand,
} from "../src/control-plane/index.js";
import { HonuaClient } from "../src/index.js";
import { HonuaStudioCommandAdapter, HonuaStudioLifecycleClient } from "../src/studio/index.js";

const identity = { actor: "editor-1", tenantId: "tenant-1" } as const;
const key = "draft-version-key";
const bearer = "synthetic-viewer-token";
const bin = path.resolve(import.meta.dirname, "../dist/src/cli/bin.js");

describe("actual honua studio draft save-version terminal", () => {
  let home: string;
  let baseUrl: string;
  let generation: number;
  let denied: boolean;
  const requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    apiKey?: string;
    correlation?: string;
    idempotency?: string;
  }> = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "",
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
      correlation: req.headers["x-correlation-id"] as string | undefined,
      idempotency: req.headers["idempotency-key"] as string | undefined,
    });
    res.setHeader("content-type", "application/json");
    res.statusCode = denied ? 403 : 200;
    res.end(
      JSON.stringify(
        denied
          ? { error: { message: "Forbidden", code: 403 } }
          : {
              success: true,
              data:
                req.method === "POST"
                  ? { versionId: "version-1", itemId: "item-1", versionNumber: 1 }
                  : { draftId: "draft-1", generation },
            },
      ),
    );
  });
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "honua-cli-draft-"));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ apiKey: "synthetic-saved-admin-key", profiles: { root: { adminKey: "synthetic-root-key" } } }),
      { mode: 0o600 },
    );
    generation = 7;
    denied = false;
    requests.length = 0;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(home, { recursive: true, force: true });
  });
  function terminal(args: string[]) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [bin, "studio", ...args],
        {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            HONUA_CONFIG_HOME: home,
            HONUA_BASE_URL: baseUrl,
            HONUA_BEARER_TOKEN: bearer,
            HONUA_ADMIN_KEY: "synthetic-environment-root-key",
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr }),
      );
    });
  }
  const invocationFlags = ["--actor", identity.actor, "--tenant", identity.tenantId, "--idempotency-key", key];
  it("executes the built CLI with identical SDK and Studio receipts, bearer identity, and generation bracketing", async () => {
    const cli = await terminal([
      "draft",
      "save-version",
      "draft-1",
      "--generation",
      "7",
      "--yes",
      "--json",
      ...invocationFlags,
    ]);
    expect(cli.stderr).toBe("");
    expect(cli.code).toBe(0);
    const receipt = JSON.parse(cli.stdout) as HonuaCommandReceipt;
    const cliRequests = requests.splice(0);
    const client = new HonuaClient({ baseUrl, bearerToken: bearer });
    const invocation = { identity, idempotencyKey: key } as const;
    const runtime = createHonuaCommandRuntime({ client, studio: new HonuaStudioLifecycleClient({ client }) });
    const sdk = await runtime.execute(
      studioDraftSaveVersionCommand,
      { draftId: "draft-1", generation: 7 },
      { ...invocation, transport: "sdk" },
    );
    const sdkRequests = requests.splice(0);
    const studio = await new HonuaStudioCommandAdapter({ client }).saveDraftVersion(
      { draftId: "draft-1", generation: 7 },
      invocation,
    );
    expect(receipt.transport).toBe("cli");
    expect(receipt.status).toBe("ok");
    expect(honuaCommandReceiptProjection(receipt)).toEqual(honuaCommandReceiptProjection(sdk));
    expect(honuaCommandReceiptProjection(receipt)).toEqual(honuaCommandReceiptProjection(studio));
    expect(cliRequests).toEqual(sdkRequests);
    expect(cliRequests).toEqual(requests);
    expect(cliRequests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/api/v1/studio/package-drafts/draft-1"],
      ["POST", "/api/v1/studio/package-drafts/draft-1/content-versions"],
      ["GET", "/api/v1/studio/package-drafts/draft-1"],
    ]);
    for (const request of cliRequests) {
      expect(request.authorization).toBe(`Bearer ${bearer}`);
      expect(request.apiKey).toBeUndefined();
      expect(request.correlation).toBe(receipt.correlationId);
      expect(request.idempotency).toBe(request.method === "POST" ? key : undefined);
    }
  });
  it("accepts generation zero and omits bracketing only when generation is absent", async () => {
    generation = 0;
    expect((await terminal(["draft", "save-version", "draft-1", "--generation", "0", "--yes", "--json"])).code).toBe(0);
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    requests.length = 0;
    expect((await terminal(["draft", "save-version", "draft-1", "--yes", "--json"])).code).toBe(0);
    expect(requests.map((request) => request.method)).toEqual(["POST"]);
  });
  it.each(["-1", "1.5", "NaN", "Infinity", "1e2", "0x10", "", " ", "9007199254740992"])(
    "rejects invalid generation %j before any request",
    async (value) => {
      const result = await terminal(["draft", "save-version", "draft-1", `--generation=${value}`, "--yes", "--json"]);
      expect(result.code).toBe(2);
      expect(requests).toEqual([]);
    },
  );
  it.each([
    ["draft", "save-version"],
    ["draft", "save-version", "draft-1", "extra"],
    ["draft", "save-version", "draft-1", "--generation"],
  ])("rejects malformed command %j before any request", async (...args) => {
    expect((await terminal([...args, "--yes"])).code).toBe(2);
    expect(requests).toEqual([]);
  });
  it("requires confirmation and previews without a write or a saved-success claim", async () => {
    expect((await terminal(["draft", "save-version", "draft-1"])).code).toBe(2);
    const preview = await terminal(["draft", "save-version", "draft-1", "--generation", "7", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("dry run");
    expect(preview.stdout).not.toContain("version saved");
    expect(requests).toEqual([]);
  });
  it("retains typed authorization refusal and correlation without retrying with saved authority", async () => {
    denied = true;
    const result = await terminal(["draft", "save-version", "draft-1", "--yes", "--json", ...invocationFlags]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr);
    expect(error.errorKind).toBe("authorization");
    expect(error.idempotencyKey).toBe(key);
    expect(requests).toHaveLength(1);
    expect(error.correlationId).toBe(requests[0].correlation);
    expect(requests[0].authorization).toBe(`Bearer ${bearer}`);
    expect(requests[0].apiKey).toBeUndefined();
  });
  it("preserves the shared generation conflict and refuses the mutation", async () => {
    const result = await terminal([
      "draft",
      "save-version",
      "draft-1",
      "--generation",
      "6",
      "--yes",
      "--json",
      ...invocationFlags,
    ]);
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.errorKind).toBe("conflict");
    expect(error.statusCode).toBe(409);
    expect(error.correlationId).toBe(requests[0].correlation);
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });
});
