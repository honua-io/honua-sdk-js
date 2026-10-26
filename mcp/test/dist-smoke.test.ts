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
      "process.stdout.write(`${typeof mod.createServer} ${typeof mod.resolveRuntimeOptions} ${typeof mod.createNlMapControlMcpHost}`);",
    ].join("\n");

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 10_000,
    });

    expect(stdout).toBe("function function function");
  });

  it("loads the published package and NL map-control subpath exports", async () => {
    const script = [
      'const root = await import("@honua/mcp-server");',
      'const nl = await import("@honua/mcp-server/nl-map-control");',
      "process.stdout.write(`${typeof root.createServer} ${typeof nl.createNlMapControlMcpHost}`);",
    ].join("\n");

    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url),
      timeout: 10_000,
    });

    expect(stdout).toBe("function function");
  });

  // The documented install line is `npx -y -p @honua/mcp-server honua-mcp`; the
  // registry lane (scripts/docs-commands-registry.mjs) proves it resolves by
  // running it with `--help` and requiring exit 0 plus the bin naming itself.
  // `--help` must therefore answer before any HONUA_BASE_URL is required.
  it.each(["--help", "-h"])("answers %s without a configured endpoint", async (flag) => {
    const env = { ...process.env };
    delete env.HONUA_BASE_URL;
    delete env.HONUA_MCP_BOOTSTRAP;
    const { stdout } = await execFileAsync(process.execPath, ["dist/src/index.js", flag], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 10_000,
    });

    expect(stdout).toContain("honua-mcp");
    expect(stdout).toContain("HONUA_BASE_URL");
  });

  it("keeps node shebang in built CLI entrypoint", async () => {
    await access("dist/src/index.js");
    const text = await readFile("dist/src/index.js", "utf8");
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
