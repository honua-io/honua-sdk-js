import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { configPath, readConfig, resolveConnection, writeConfig } from "../src/cli/config.js";

describe("CLI credential config persistence", () => {
  it("atomically replaces an existing config with an owner-only credential file", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-cli-config-private-"));
    const env = { HONUA_CONFIG_HOME: directory };
    const file = configPath(env);
    writeFileSync(file, '{"apiKey":"old"}\n', { encoding: "utf8", mode: 0o644 });
    try {
      expect(
        await writeConfig(
          {
            profiles: {
              release: {
                baseUrl: "https://example.test",
                apiKey: "scoped-secret",
                adminKey: "root-secret",
              },
            },
          },
          env,
        ),
      ).toBe(file);
      expect(readConfig(env)).toEqual({
        profiles: {
          release: {
            baseUrl: "https://example.test",
            apiKey: "scoped-secret",
            adminKey: "root-secret",
          },
        },
      });
      expect(readFileSync(file, "utf8")).not.toContain('"apiKey":"old"');
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to consume a legacy config whose privacy was never verified", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-cli-config-legacy-"));
    const env = { HONUA_CONFIG_HOME: directory };
    const file = configPath(env);
    writeFileSync(file, '{"adminKey":"possibly-exposed"}\n', { encoding: "utf8", mode: 0o644 });
    if (process.platform !== "win32") chmodSync(file, 0o644);
    try {
      expect(() => readConfig(env)).toThrow("Refusing to read CLI credentials from an unverified private file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic-link config destination", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-cli-config-symlink-"));
    const outside = path.join(directory, "outside.json");
    const env = { HONUA_CONFIG_HOME: path.join(directory, "config") };
    writeFileSync(outside, "preserve\n", "utf8");
    mkdirSync(env.HONUA_CONFIG_HOME, { recursive: true });
    symlinkSync(outside, configPath(env));
    try {
      expect(() => readConfig(env)).toThrow("unverified private file");
      await expect(writeConfig({ apiKey: "must-not-escape" }, env)).rejects.toThrow("symbolic-link credential file");
      expect(readFileSync(outside, "utf8")).toBe("preserve\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not replay a saved key onto a different host or profile", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-cli-config-binding-"));
    const env = { HONUA_CONFIG_HOME: directory };
    try {
      await writeConfig(
        {
          baseUrl: "https://prod.example",
          apiKey: "prod-key",
          profiles: { staging: { baseUrl: "https://staging.example", apiKey: "staging-key" } },
        },
        env,
      );
      expect(resolveConnection({ baseUrl: "http://localhost:8080", env }).apiKey).toBeUndefined();
      expect(resolveConnection({ profile: "staging", env }).apiKey).toBe("staging-key");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
