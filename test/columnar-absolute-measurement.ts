import { spawnSync } from "node:child_process";

import {
  COLUMNAR_ABSOLUTE_RECIPES,
  type ColumnarAbsoluteScenario,
  parseColumnarAbsoluteReport,
} from "../bench/columnar-absolute-protocol.js";
import { getPreparedColumnarAbsoluteRunnerPath } from "./prepared-sdk-artifacts.js";

/** Keep V8 coverage on the parent semantic run; never time instrumented code. */
export function measureColumnarAbsolute(scenario: ColumnarAbsoluteScenario) {
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      getPreparedColumnarAbsoluteRunnerPath(),
      JSON.stringify({ scenario, recipe: COLUMNAR_ABSOLUTE_RECIPES[scenario] }),
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  if (child.error || child.signal || child.status !== 0) {
    throw new Error(`Absolute timing child failed: ${child.error?.message ?? child.signal ?? child.stderr}`);
  }
  return parseColumnarAbsoluteReport(child.stdout, scenario, process.version, process.execPath);
}
