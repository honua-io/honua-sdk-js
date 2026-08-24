import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writePrivateFileAtomic } from "../src/private-file.js";

describe("private credential file transactions", () => {
  it("binds the prepared pathname to the original file identity", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-private-file-identity-"));
    const destination = path.join(directory, "credential.json");
    const stolen = path.join(directory, "stolen.tmp");
    try {
      await expect(
        writePrivateFileAtomic(destination, "must-not-be-lost", {
          async afterPrepared() {
            const temporary = readdirSync(directory).find((name) => name.startsWith(".credential.json."));
            if (!temporary) throw new Error("prepared private temp was not found");
            const temporaryPath = path.join(directory, temporary);
            renameSync(temporaryPath, stolen);
            await writePrivateFileAtomic(temporaryPath, "attacker-substitution");
          },
        }),
      ).rejects.toThrow("pathname identity changed");
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(stolen, "utf8")).not.toContain("must-not-be-lost");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["afterRename", "afterVerify"] as const)("removes only its own final file after %s failure", async (hook) => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-private-file-cleanup-"));
    const destination = path.join(directory, "credential.json");
    try {
      await expect(
        writePrivateFileAtomic(destination, "must-not-remain", {
          [hook]: async () => {
            throw new Error(`injected ${hook} failure`);
          },
        }),
      ).rejects.toThrow(`injected ${hook} failure`);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "never executes planted Windows ACL utilities from the credential directory",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "honua-private-file-windows-path-"));
      const destination = path.join(directory, "credential.json");
      try {
        for (const executable of ["whoami.exe", "icacls.exe", "powershell.exe"]) {
          writeFileSync(path.join(directory, executable), "not a Windows executable", "utf8");
        }
        await expect(writePrivateFileAtomic(destination, "private")).resolves.toBeUndefined();
        expect(readFileSync(destination, "utf8")).toBe("private");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
