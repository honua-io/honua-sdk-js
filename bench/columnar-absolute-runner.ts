import {
  COLUMNAR_ABSOLUTE_RECIPES,
  assertUninstrumentedRuntime,
  parseColumnarAbsoluteRequest,
} from "./columnar-absolute-protocol.js";
import { runColumnarAggregateBenchmark } from "./columnar-aggregate-bench.js";
import { runColumnarPatchBenchmark } from "./columnar-patch-bench.js";

assertUninstrumentedRuntime(process.execArgv, process.env);
const scenario = parseColumnarAbsoluteRequest(process.argv[2] ?? "");
const result =
  scenario === "patch"
    ? await runColumnarPatchBenchmark(COLUMNAR_ABSOLUTE_RECIPES.patch)
    : await runColumnarAggregateBenchmark(COLUMNAR_ABSOLUTE_RECIPES.aggregate);
const samples = result.samples.map((sample) =>
  "patchLatencyMs" in sample ? sample.patchLatencyMs : sample.inputRowsPerSecond,
);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    scenario,
    recipe: COLUMNAR_ABSOLUTE_RECIPES[scenario],
    runtime: process.version,
    executable: process.execPath,
    instrumentation: "none",
    samples,
    invariants: result.invariants,
  })}\n`,
);
