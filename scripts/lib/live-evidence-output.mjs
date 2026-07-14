import path from "node:path";
import process from "node:process";

export function liveEvidenceOutputContract(expectedSampleId, defaultOutput) {
  const requestedSampleId = process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID;
  if (requestedSampleId && requestedSampleId !== expectedSampleId) {
    throw new Error(`${expectedSampleId} live evidence cannot satisfy ${requestedSampleId}`);
  }
  const sourceRevision = process.env.HONUA_SAMPLE_SOURCE_REVISION;
  if (sourceRevision !== undefined && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error("HONUA_SAMPLE_SOURCE_REVISION must be a full lowercase Git SHA");
  }
  return {
    output: path.resolve(process.env.HONUA_SAMPLE_LIVE_OUTPUT ?? defaultOutput),
    sourceRevision,
  };
}
