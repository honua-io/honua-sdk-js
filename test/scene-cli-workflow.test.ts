import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";
import {
  HONUA_SCENE_COMMANDS,
  HONUA_SCENE_COMMAND_IDS,
  createHonuaCommandRuntime,
  honuaCommandAuditKey,
  pendingSceneUploadChunks,
  pollSceneJobUntilTerminal,
  sceneImportSubmitCommand,
  sceneJobCancelCommand,
  sceneJobStatusCommand,
  sceneResolveCommand,
  sceneRetireCommand,
  sceneUploadCreateCommand,
  validateSceneUploadResumeState,
} from "../src/control-plane/index.js";
import { HonuaClient } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface RecordedHttp {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function makeRecorder(
  handler: (req: RecordedHttp) => { status?: number; body?: unknown; headers?: Record<string, string> },
): { readonly requests: RecordedHttp[]; readonly fetchFn: typeof fetch } {
  const requests: RecordedHttp[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const entries =
        init.headers instanceof Headers
          ? [...init.headers.entries()]
          : Array.isArray(init.headers)
            ? init.headers
            : Object.entries(init.headers);
      for (const [k, v] of entries) headers[k.toLowerCase()] = v;
    }
    const req: RecordedHttp = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const reply = handler(req);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

function captureStreams(): { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}

describe("terminal-first scene workflow commands and CLI", () => {
  it("registers all 6 scene commands with closed schemas and transport-invariant audit keys", async () => {
    expect([...HONUA_SCENE_COMMAND_IDS]).toEqual([
      "scene.upload.create",
      "scene.import.submit",
      "scene.job.status",
      "scene.job.cancel",
      "scene.resolve",
      "scene.retire",
    ]);

    for (const id of HONUA_SCENE_COMMAND_IDS) {
      const cmd = HONUA_SCENE_COMMANDS[id];
      expect(cmd.id).toBe(id);
      expect(cmd.inputSchema.additionalProperties).toBe(false);
    }

    const { requests, fetchFn } = makeRecorder(() => ({
      status: 202,
      body: { accepted: true, status: "running", jobId: "job-77", sceneId: "harbor-3d" },
    }));
    const client = new HonuaClient({ baseUrl: "https://scenes.test", fetchFn });
    const runtime = createHonuaCommandRuntime({ client });

    // Dry-run never issues an HTTP request and produces identical auditKey across transports.
    const cliDry = await runtime.execute(
      sceneImportSubmitCommand,
      { format: "3d-tiles", uploadId: "up-1", sceneId: "harbor-3d" },
      { transport: "cli", dryRun: true, idempotencyKey: "idem-1" },
    );
    const mcpDry = await runtime.execute(
      sceneImportSubmitCommand,
      { format: "3d-tiles", uploadId: "up-1", sceneId: "harbor-3d" },
      { transport: "mcp", dryRun: true, idempotencyKey: "idem-1" },
    );
    expect(requests).toHaveLength(0);
    expect(cliDry.status).toBe("dry-run");
    expect(cliDry.auditKey).toBe(mcpDry.auditKey);
    expect(cliDry.auditKey).toBe(honuaCommandAuditKey(cliDry));

    // Closed schema rejects unknown properties (e.g., approval bypass fields).
    await expect(
      runtime.execute(sceneRetireCommand, { sceneId: "harbor-3d", approved: true } as unknown as { sceneId: string }, {
        transport: "cli",
      }),
    ).rejects.toThrow();
  });

  it("validates non-secret resume checkpoints and polls async 202 jobs until terminal status", async () => {
    const payload = Buffer.from("synthetic-3d-tiles-archive-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const saved = {
      uploadId: "up-42",
      status: "open" as const,
      sceneId: "campus",
      fileName: "campus.zip",
      format: "3d-tiles" as const,
      totalBytes: 12_000,
      chunkBytes: 4_096,
      sha256,
      acknowledgedChunks: [0, 2],
    };

    expect(() =>
      validateSceneUploadResumeState(saved, { sha256, totalBytes: 12_000, sceneId: "campus" }),
    ).not.toThrow();
    expect(() => validateSceneUploadResumeState(saved, { sha256: "0".repeat(64), totalBytes: 12_000 })).toThrow(
      /SHA-256/,
    );
    expect(() => validateSceneUploadResumeState(saved, { sha256, totalBytes: 999 })).toThrow(/size/);
    expect(() => validateSceneUploadResumeState(saved, { sha256, totalBytes: 12_000, sceneId: "other-scene" })).toThrow(
      /sceneId/,
    );
    expect(pendingSceneUploadChunks(saved)).toEqual([1]);

    let calls = 0;
    const states = ["queued", "running", "succeeded"];
    const terminal = await pollSceneJobUntilTerminal({
      pollIntervalMs: 1,
      timeoutMs: 2_000,
      fetchStatus: async () => {
        const status = states[Math.min(calls, states.length - 1)]!;
        calls += 1;
        return { id: "job-99", status };
      },
    });
    expect(terminal.status).toBe("succeeded");
    expect(calls).toBe(3);
  });

  it("executes end-to-end honua scene CLI subcommands (upload --resume, import --wait, status, cancel, list, get, resolve, retire) without persisting secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "honua-scene-cli-"));
    const archivePath = join(dir, "downtown.zip");
    const resumePath = join(dir, "resume.json");
    writeFileSync(archivePath, Buffer.alloc(4096, 7));

    try {
      let pollCount = 0;
      const { requests, fetchFn } = makeRecorder((req) => {
        if (req.method === "POST" && req.path === "/api/v1/admin/scenes/uploads") {
          return {
            status: 201,
            body: {
              uploadId: "up-cli-1",
              status: "open",
              sceneId: "downtown",
              fileName: "downtown.zip",
              format: "3d-tiles",
              totalBytes: 4096,
              chunkBytes: 2048,
              sha256: (req.body as { sha256: string }).sha256,
              acknowledgedChunks: [0],
              // Simulate a server accidentally returning a secret-like field; sanitizer must drop it!
              signedUrl: "https://storage.example/put?sig=DO_NOT_SAVE",
              bearerToken: "DO_NOT_SAVE_TOKEN",
            },
          };
        }
        if (req.method === "POST" && req.path === "/api/v1/admin/scenes/imports") {
          return {
            status: 202,
            body: { accepted: true, status: "queued", jobId: "job-cli-1", sceneId: "downtown" },
          };
        }
        if (req.method === "GET" && req.path === "/api/v1/admin/scenes/jobs/job-cli-1") {
          pollCount += 1;
          return {
            status: 200,
            body: { id: "job-cli-1", status: pollCount >= 2 ? "succeeded" : "running" },
          };
        }
        if (req.method === "POST" && req.path === "/api/v1/admin/scenes/jobs/job-cli-2/cancel") {
          return { status: 200, body: { id: "job-cli-2", status: "cancelled" } };
        }
        if (req.method === "GET" && req.path === "/api/scenes") {
          return {
            status: 200,
            body: {
              scenes: [
                {
                  sceneId: "downtown",
                  title: "Downtown 3D",
                  servingFormat: "3d-tiles",
                  auth: { requiresAuthentication: false },
                },
              ],
            },
          };
        }
        if (req.method === "GET" && req.path === "/api/scenes/downtown") {
          return {
            status: 200,
            body: {
              sceneId: "downtown",
              title: "Downtown 3D",
              tilesetUrl: "https://scenes.test/scenes/downtown/tileset.json",
              capabilities: ["3d-tiles"],
              auth: { requiresAuthentication: false },
            },
          };
        }
        if (req.method === "GET" && req.path === "/api/v1/admin/scenes/downtown/resolve") {
          return {
            status: 200,
            body: {
              sceneId: "downtown",
              tilesetUrl: "https://scenes.test/scenes/downtown/tileset.json",
              endpoints: [],
              capabilities: ["3d-tiles"],
              auth: { requiresAuthentication: true },
              accessAffordance: { method: "POST", path: "/scenes/downtown/access-envelope" },
            },
          };
        }
        if (req.method === "DELETE" && req.path === "/api/v1/admin/scenes/downtown") {
          return { status: 200, body: { retired: true } };
        }
        return { status: 404, body: { error: `unexpected ${req.method} ${req.path}` } };
      });

      vi.stubGlobal("fetch", fetchFn);

      // 1. Upload with --resume writes sanitized non-secret state
      const out1 = captureStreams();
      const code1 = await run([
        "scene",
        "upload",
        archivePath,
        "--format",
        "3d-tiles",
        "--scene-id",
        "downtown",
        "--chunk-bytes",
        "2048",
        "--resume",
        resumePath,
        "--yes",
        "--json",
        "--base-url",
        "https://scenes.test",
        "--api-key",
        "super-secret-api-key",
      ]);
      expect(code1).toBe(0);
      const resumeRaw = readFileSync(resumePath, "utf8");
      expect(resumeRaw).not.toContain("super-secret-api-key");
      expect(resumeRaw).not.toContain("DO_NOT_SAVE");
      expect(JSON.parse(resumeRaw).uploadId).toBe("up-cli-1");
      expect(JSON.parse(out1.stdout.join("")).pendingChunks).toEqual([1]);

      // 2. Import with --wait polls async 202 job to completion
      const out2 = captureStreams();
      const code2 = await run([
        "scene",
        "import",
        "--format",
        "3d-tiles",
        "--upload-id",
        "up-cli-1",
        "--scene-id",
        "downtown",
        "--wait",
        "--yes",
        "--json",
        "--base-url",
        "https://scenes.test",
      ]);
      expect(code2).toBe(0);
      const importJson = JSON.parse(out2.stdout.join(""));
      expect(importJson.output.jobId).toBe("job-cli-1");
      expect(importJson.finalJob.status).toBe("succeeded");

      // 3. list, get, resolve, cancel, retire
      const outList = captureStreams();
      expect(await run(["scene", "list", "--json", "--base-url", "https://scenes.test"])).toBe(0);
      expect(JSON.parse(outList.stdout.join("")).scenes[0].sceneId).toBe("downtown");

      const outGet = captureStreams();
      expect(await run(["scene", "get", "downtown", "--json", "--base-url", "https://scenes.test"])).toBe(0);
      expect(JSON.parse(outGet.stdout.join("")).sceneId).toBe("downtown");

      const outResolve = captureStreams();
      expect(await run(["scene", "resolve", "downtown", "--json", "--base-url", "https://scenes.test"])).toBe(0);
      expect(JSON.parse(outResolve.stdout.join("")).output.accessAffordance.method).toBe("POST");

      const outCancel = captureStreams();
      expect(await run(["scene", "cancel", "job-cli-2", "--yes", "--json", "--base-url", "https://scenes.test"])).toBe(
        0,
      );
      expect(JSON.parse(outCancel.stdout.join("")).output.status).toBe("cancelled");

      const outRetire = captureStreams();
      expect(await run(["scene", "retire", "downtown", "--yes", "--json", "--base-url", "https://scenes.test"])).toBe(
        0,
      );
      expect(JSON.parse(outRetire.stdout.join("")).output.retired).toBe(true);

      // Verify runtime helpers also execute directly through SDK
      const runtime = createHonuaCommandRuntime({
        client: new HonuaClient({ baseUrl: "https://scenes.test", fetchFn }),
      });
      const statusReceipt = await runtime.execute(sceneJobStatusCommand, { jobId: "job-cli-1" }, { transport: "sdk" });
      expect(statusReceipt.output?.status).toBe("succeeded");
      const cancelReceipt = await runtime.execute(sceneJobCancelCommand, { jobId: "job-cli-2" }, { transport: "sdk" });
      expect(cancelReceipt.output?.status).toBe("cancelled");
      const resolveReceipt = await runtime.execute(sceneResolveCommand, { sceneId: "downtown" }, { transport: "sdk" });
      expect(resolveReceipt.output?.sceneId).toBe("downtown");
      const uploadDry = await runtime.execute(
        sceneUploadCreateCommand,
        {
          fileName: "downtown.zip",
          format: "3d-tiles",
          totalBytes: 4096,
          sha256: "a".repeat(64),
        },
        { transport: "sdk", dryRun: true },
      );
      expect(uploadDry.status).toBe("dry-run");
      expect(requests.length).toBeGreaterThanOrEqual(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
