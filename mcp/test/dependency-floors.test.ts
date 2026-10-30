import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
  packages: Record<string, { version?: string }>;
};
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  overrides: Record<string, string>;
};

/** Numeric major.minor.patch compare. Pre-release tags are ignored. */
function versionAtLeast(version: string, floor: string): boolean {
  const left =
    version
      .split("-")[0]
      ?.split(".")
      .map((part) => Number(part)) ?? [];
  const right = floor.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

it("pins @hono/node-server above GHSA-rmxm-3fg6-px4f", () => {
  expect(manifest.overrides["@hono/node-server"]).toBe("^2.1.3");
  expect(versionAtLeast(lock.packages["node_modules/@hono/node-server"]?.version ?? "0.0.0", "2.1.3")).toBe(true);
});

it("pins qs above GHSA-6pq8-jhm2-2vcw", () => {
  expect(manifest.overrides.qs).toBe("^6.16.1");
  expect(versionAtLeast(lock.packages["node_modules/qs"]?.version ?? "0.0.0", "6.16.1")).toBe(true);
});
