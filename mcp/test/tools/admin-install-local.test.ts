import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { execute, schema } from "../../src/tools/admin-install-local.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("honua_admin_install_local", () => {
  it("requires explicit confirmation", () => {
    expect(() => schema.parse({ directory: "x" })).toThrow();
  });

  it("fails before Docker while the release image regresses the Admin contract", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-mcp-install-"));
    cleanup.push(directory);
    let commands = 0;
    await expect(
      execute(schema.parse({ directory, profile: "quickstart", confirm: true }), {
        run: async () => {
          commands += 1;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      }),
    ).rejects.toThrow(/manifest-pinned server.*395.*requires 396/s);
    expect(commands).toBe(0);
  });
});
