import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLiveExecutable, runZeroToMapCli } from "../../src/release/zero-to-map-cli.js";

describe("zero-to-map live process boundary", () => {
  it("resolves the Honua CLI from an absolute PATH entry, never the working directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "honua-live-executable-"));
    const working = path.join(root, "working");
    const trusted = path.join(root, "trusted");
    const executableName = process.platform === "win32" ? "honua.exe" : "honua";
    await Promise.all([mkdir(working), mkdir(trusted)]);
    const planted = path.join(working, executableName);
    const expected = path.join(trusted, executableName);
    await Promise.all([writeFile(planted, "planted"), writeFile(expected, "trusted")]);
    if (process.platform !== "win32") await Promise.all([chmod(planted, 0o755), chmod(expected, 0o755)]);
    try {
      await expect(
        resolveLiveExecutable(
          "honua",
          { PATH: `${working}${path.delimiter}${trusted}`, PATHEXT: ".EXE;.CMD" },
          working,
        ),
      ).resolves.toBe(await realpath(expected));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative executable paths that could escape PATH resolution", async () => {
    await expect(resolveLiveExecutable(".\\honua.exe", process.env, process.cwd())).rejects.toThrow("must be absolute");
  });

  it("rejects a non-loopback plaintext MCP and GPServer credential origin before execution", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honua-live-endpoint-"));
    try {
      await expect(
        runZeroToMapCli(
          [
            "--execute",
            "--yes",
            "--plan",
            path.resolve("release/zero-to-map/journey.v1.json"),
            "--mcp-url",
            "http://example.test/mcp",
            "--checkpoint",
            path.join(directory, "checkpoint.json"),
            "--var",
            "candidateId=candidate-1",
            "--var",
            "releaseId=2026.1",
          ],
          { HONUA_SOURCE_REVISION: "a".repeat(40) },
        ),
      ).rejects.toThrow("requires HTTPS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
