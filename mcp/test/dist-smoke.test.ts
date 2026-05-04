import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("distribution smoke", () => {
  it("loads built entrypoint exports", async () => {
    const entrypointUrl = new URL("../dist/src/index.js", import.meta.url).href;
    const script = [
      `const mod = await import(${JSON.stringify(entrypointUrl)});`,
      "process.stdout.write(`${typeof mod.createServer} ${typeof mod.resolveRuntimeOptions}`);",
    ].join("\n");

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 10_000,
    });

    expect(stdout).toBe("function function");
  });

  it("keeps node shebang in built CLI entrypoint", async () => {
    await access("dist/src/index.js");
    const text = await readFile("dist/src/index.js", "utf8");
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
