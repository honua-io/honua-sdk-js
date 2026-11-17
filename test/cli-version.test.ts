import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/cli/main.js";

const readJson = (file: string) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

describe("CLI version", () => {
  it("reports the package version", () => {
    expect(CLI_VERSION).toBe(readJson("package.json").version);
  });

  it("is stamped by release-please on every release", () => {
    const extraFiles: { type: string; path: string }[] =
      readJson("release-please-config.json").packages["."]["extra-files"];
    expect(extraFiles).toContainEqual({ type: "generic", path: "src/cli/main.ts" });
    const source = fs.readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
    expect(source).toMatch(/^export const CLI_VERSION = "[^"]+"; \/\/ x-release-please-version$/m);
  });
});
