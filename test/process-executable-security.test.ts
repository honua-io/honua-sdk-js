import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveExecutableFromPath } from "../src/process-executable.js";

describe("external executable resolution", () => {
  it("never resolves Docker from the selected working directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "honua-executable-path-"));
    const selected = path.join(root, "selected");
    const trusted = path.join(root, "trusted");
    const executableName = process.platform === "win32" ? "docker.exe" : "docker";
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(selected), mkdir(trusted)]));
    const planted = path.join(selected, executableName);
    const expected = path.join(trusted, executableName);
    writeFileSync(planted, "planted", "utf8");
    writeFileSync(expected, "trusted", "utf8");
    if (process.platform !== "win32") {
      chmodSync(planted, 0o755);
      chmodSync(expected, 0o755);
    }
    try {
      await expect(
        resolveExecutableFromPath("docker", {
          env: { PATH: `${selected}${path.delimiter}${trusted}`, PATHEXT: ".EXE;.CMD" },
          excludedDirectory: selected,
        }),
      ).resolves.toBe(await import("node:fs/promises").then(({ realpath }) => realpath(expected)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
