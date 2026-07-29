import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MCP_OUTPUT_DIRECTORIES, cleanMcpOutputs } from "../scripts/clean-output.mjs";

const tempRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map(async (root) => {
      tempRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("MCP package workflow", () => {
  it("keeps clean, build, and publish producers Windows-portable", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.clean).toBe("node scripts/clean-output.mjs");
    expect(manifest.scripts.build).toBe("npm run clean --silent && tsc -p tsconfig.json");
    expect(manifest.scripts.prepack).toBe("npm run build --silent");
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(command, `${name} must not use a POSIX-only filesystem producer`).not.toMatch(
        /(?:^|&&\s*|\|\|\s*|;\s*)(?:rm|cp|mv)\s|(?:^|\s)mkdir\s+-p(?:\s|$)/,
      );
    }
  });

  it("removes only the bounded MCP output directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "honua-mcp-clean-"));
    tempRoots.add(root);
    for (const name of MCP_OUTPUT_DIRECTORIES) {
      await mkdir(path.join(root, name, "nested"), { recursive: true });
      await writeFile(path.join(root, name, "nested", "artifact.txt"), "generated");
    }
    const sentinel = path.join(root, "package.json");
    await writeFile(sentinel, '{"private":true}\n');

    cleanMcpOutputs(root);

    for (const name of MCP_OUTPUT_DIRECTORIES) {
      await expect(readFile(path.join(root, name, "nested", "artifact.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(readFile(sentinel, "utf8")).resolves.toBe('{"private":true}\n');
  });
});
