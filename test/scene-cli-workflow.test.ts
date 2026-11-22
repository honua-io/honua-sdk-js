import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";
import {
  HONUA_SCENE_COMMANDS,
  HONUA_SCENE_COMMAND_IDS,
  createHonuaCommandRuntime,
  honuaCommandAuditKey,
  pollSceneJobUntilTerminal,
  sceneJobStatusCommand,
  sceneResolveCommand,
  sceneRetireCommand,
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
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : init?.body,
    };
    requests.push(req);
    const reply = handler(req);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
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

describe("scene catalog commands and CLI", () => {
  it("registers supported commands with closed schemas and stable dry-run audit keys", async () => {
    expect([...HONUA_SCENE_COMMAND_IDS]).toEqual(["scene.job.status", "scene.resolve", "scene.retire"]);
    for (const id of HONUA_SCENE_COMMAND_IDS) {
      expect(HONUA_SCENE_COMMANDS[id].id).toBe(id);
      expect(HONUA_SCENE_COMMANDS[id].inputSchema.additionalProperties).toBe(false);
    }
    const { requests, fetchFn } = makeRecorder(() => ({ status: 404 }));
    const runtime = createHonuaCommandRuntime({ client: new HonuaClient({ baseUrl: "https://scenes.test", fetchFn }) });
    const input = { jobId: "job-77" };
    const cliDry = await runtime.execute(sceneJobStatusCommand, input, { transport: "cli", dryRun: true });
    const mcpDry = await runtime.execute(sceneJobStatusCommand, input, { transport: "mcp", dryRun: true });
    expect(requests).toHaveLength(0);
    expect(cliDry.status).toBe("dry-run");
    expect(cliDry.auditKey).toBe(mcpDry.auditKey);
    expect(cliDry.auditKey).toBe(honuaCommandAuditKey(cliDry));
    await expect(
      runtime.execute(sceneRetireCommand, { sceneId: "downtown", approved: true } as { sceneId: string }, {
        transport: "cli",
      }),
    ).rejects.toThrow();
  });

  it("polls running jobs until the server reports a terminal state", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ id: "job-99", status: "queued" })
      .mockResolvedValueOnce({ id: "job-99", status: "running" })
      .mockResolvedValue({ id: "job-99", status: "succeeded" });
    const terminal = await pollSceneJobUntilTerminal({ pollIntervalMs: 1, timeoutMs: 2000, fetchStatus });
    expect(terminal.status).toBe("succeeded");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("uses the server multipart ingest, job, catalog and retirement contracts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "honua-scene-cli-"));
    const archivePath = join(dir, "downtown.zip");
    const modelPath = join(dir, "downtown.glb");
    const datasetId = "da6092da-af15-4860-9595-81156c610899";
    writeFileSync(archivePath, "archive bytes");
    writeFileSync(modelPath, "model bytes");
    try {
      const url = "https://scenes.test/scenes/downtown/tileset.json";
      const scene = {
        sceneId: "downtown",
        title: "Downtown 3D",
        servingFormat: "3d-tiles",
        contentKind: "mesh",
        tilesetUrl: url,
        capabilities: ["3d-tiles"],
        endpoints: [
          {
            kind: "3d-tiles",
            endpointFormat: "3d-tiles",
            url,
            mediaType: "application/json",
            format: "3d-tiles",
            requiresAuthentication: true,
            accessSession: { href: "https://scenes.test/scenes/downtown/access-envelope", method: "POST" },
          },
        ],
        auth: { requiresAuthentication: true, schemes: ["Bearer", "ApiKey"] },
      };
      const jobUrl = "/api/v1/admin/scenes/jobs/job-cli-1";
      const { requests, fetchFn } = makeRecorder(({ method, path }) => {
        if (method === "POST" && path.endsWith("/ingest/model")) {
          return { status: 201, body: { sceneId: "downtown", tilesetUrl: url, sourceFormat: "glb", warnings: [] } };
        }
        if (method === "POST" && path.endsWith("/ingest/archive")) {
          return {
            status: 202,
            body: { status: "queued", jobId: "job-cli-1", sceneId: "downtown", statusUrl: jobUrl },
          };
        }
        if (method === "GET" && path === jobUrl) return { body: { jobId: "job-cli-1", status: "succeeded" } };
        if (method === "GET" && path === "/api/scenes") return { body: { scenes: [scene] } };
        if (method === "GET" && ["/api/scenes/downtown", "/api/scenes/downtown/resolve"].includes(path))
          return { body: scene };
        if (method === "DELETE" && path === `/api/v1/admin/scenes/${datasetId}`) return { status: 204 };
        return { status: 404, body: { error: `unexpected ${method} ${path}` } };
      });
      vi.stubGlobal("fetch", fetchFn);
      const cli = async (args: string[]) => {
        const out = captureStreams();
        const code = await run(["scene", ...args, "--json", "--base-url", "https://scenes.test"]);
        expect(code, out.stderr.join("")).toBe(0);
        return JSON.parse(out.stdout.join(""));
      };
      const archive = await cli([
        "import",
        archivePath,
        "--format",
        "3d-tiles",
        "--scene-id",
        "downtown",
        "--async",
        "--wait",
        "--yes",
      ]);
      expect(archive.output.jobId).toBe("job-cli-1");
      expect(archive.finalJob.status).toBe("succeeded");
      const archiveForm = requests[0]?.body as FormData;
      expect(archiveForm.get("async")).toBe("true");
      expect(archiveForm.get("sceneId")).toBe("downtown");
      const file = archiveForm.get("file") as File;
      expect(file.name).toBe("downtown.zip");
      expect(await file.text()).toBe("archive bytes");
      expect(requests[0]?.headers["content-type"]).toBeUndefined();

      const model = await cli([
        "import",
        modelPath,
        "--format",
        "glb",
        "--longitude",
        "-157.82",
        "--latitude",
        "21.3",
        "--yes",
      ]);
      const modelForm = requests.find(({ path }) => path.endsWith("/ingest/model"))?.body as FormData;
      expect(model.output.tilesetUrl).toBe(url);
      expect(modelForm.get("async")).toBeNull();
      expect(modelForm.get("longitude")).toBe("-157.82");
      expect(modelForm.get("latitude")).toBe("21.3");
      expect((modelForm.get("file") as File).name).toBe("downtown.glb");
      expect((await cli(["list"])).scenes[0].sceneId).toBe("downtown");
      expect((await cli(["get", "downtown"])).sceneId).toBe("downtown");
      expect((await cli(["resolve", "downtown"])).output.accessAffordance.method).toBe("POST");
      expect((await cli(["retire", datasetId, "--yes"])).output.retired).toBe(true);

      const runtime = createHonuaCommandRuntime({
        client: new HonuaClient({ baseUrl: "https://scenes.test", fetchFn }),
      });
      const result = await runtime.execute(sceneResolveCommand, { sceneId: "downtown" }, { transport: "sdk" });
      expect(result.output?.sceneId).toBe("downtown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews a missing file and rejects unsupported operations before transport", async () => {
    const { requests, fetchFn } = makeRecorder(() => ({ status: 404 }));
    vi.stubGlobal("fetch", fetchFn);
    const runScene = (args: string[]) => run(["scene", ...args, "--json", "--base-url", "https://scenes.test"]);
    const out = captureStreams();
    expect(await runScene(["import", "missing.zip", "--format", "3d-tiles", "--dry-run"])).toBe(0);
    expect(JSON.parse(out.stdout.join("")).status).toBe("dry-run");
    for (const args of [
      ["upload", "missing.zip"],
      ["cancel", "job-cli-1"],
      ["import", "missing.glb", "--format", "glb", "--yes"],
    ])
      expect(await runScene(args)).not.toBe(0);
    expect(requests).toHaveLength(0);
  });
});
