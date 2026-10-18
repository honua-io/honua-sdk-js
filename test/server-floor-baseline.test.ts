import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, evaluateCompatibility } from "../src/core/compatibility.js";
import type { HonuaServerCompatibility } from "../src/core/types.js";

// honua-release docs/SDK-SERVER-BASELINE-RULE.md "Runtime floor constants" (#233): a
// first-release baseline maps to the least SemVer identity of the first server release line.
const FIRST_RELEASE_RUNTIME_FLOOR = "2026.1.0-0";

const baseline = JSON.parse(
  readFileSync(new URL("../release/sdk-capability-baseline.json", import.meta.url), "utf8"),
) as {
  minimumServerVersion: string;
};

function compatibility(serverVersion: string): HonuaServerCompatibility {
  return {
    serverVersion,
    releaseChannel: "stable",
    controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
    metadataSchemas: [],
    features: {
      metadataResources: true,
      manifestExport: true,
      manifestApply: true,
      manifestDryRun: true,
      manifestPrune: true,
    },
  };
}

describe("runtime server floor (honua-release#233)", () => {
  it("is the value the capability baseline file derives", () => {
    const expected =
      baseline.minimumServerVersion === "first-release" ? FIRST_RELEASE_RUNTIME_FLOOR : baseline.minimumServerVersion;
    expect(HONUA_MINIMUM_SUPPORTED_SERVER_VERSION).toBe(expected);
  });

  it.each(["2026.1.0-rc.1", "2026.1.0-rc.3", "2026.1.0", "2026.1.1+c19f29d1828814f0", "2026.2.0"])(
    "accepts first-release-line server %s",
    (serverVersion) => {
      expect(evaluateCompatibility(compatibility(serverVersion))).toEqual([]);
    },
  );

  it.each(["1.0.0", "1.0.0+0e03bdd06b3ca3fb", "0.1.0", "2025.12.0"])(
    "refuses server %s, which predates the first release line",
    (serverVersion) => {
      expect(evaluateCompatibility(compatibility(serverVersion))).toEqual([
        `Server version ${serverVersion} is older than the minimum supported ${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}.`,
      ]);
    },
  );
});
