import { readFile } from "node:fs/promises";

// A Vite writeBundle budget failure can leave a complete emitted inventory;
// preserve it for measurement. Earlier build failures may emit no inventory at
// all: retain that original error without inventing a zero-byte measurement.
export async function readFirstMapBuildResolution(file, buildFailure) {
  try {
    return { resolution: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    if (buildFailure === undefined) throw error;
    return {
      unavailable: {
        buildStatus: "failed",
        diagnostic: buildFailure,
        resolutionStatus: "unavailable",
        resolutionDiagnostic: error instanceof Error ? error.message : String(error),
        measurement: null,
      },
    };
  }
}
