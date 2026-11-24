import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(resolve("release-please-config.json"), "utf8")) as {
  "separate-pull-requests"?: boolean;
  "always-update"?: boolean;
};

describe("release-please component pull requests", () => {
  it("splits component releases so create-honua-app can publish without js-sdk 0.3.0", () => {
    expect(config["separate-pull-requests"]).toBe(true);
  });

  it("rebuilds each open release pull request from trunk so a sibling release merge cannot leave it conflicting", () => {
    expect(config["always-update"]).toBe(true);
  });
});
