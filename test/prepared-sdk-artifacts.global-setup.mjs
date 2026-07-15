import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  manifestPathFor,
  PREPARED_SDK_RUN_ID_ENV,
  verifyPreparedSdkArtifact,
} from "../scripts/lib/prepared-sdk-artifact.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function setupPreparedSdkArtifact(root = projectRoot, environment = process.env) {
  if (!fs.existsSync(manifestPathFor(root))) {
    delete environment[PREPARED_SDK_RUN_ID_ENV];
    return undefined;
  }
  const manifest = verifyPreparedSdkArtifact({ projectRoot: root });
  environment[PREPARED_SDK_RUN_ID_ENV] = manifest.runId;

  return function teardownPreparedSdkArtifact() {
    verifyPreparedSdkArtifact({
      projectRoot: root,
      expectedRunId: manifest.runId,
      expectedInputSha256: manifest.inputs.sha256,
      expectedDistSha256: manifest.dist.sha256,
    });
  };
}

export default function setupDefaultPreparedSdkArtifact() {
  return setupPreparedSdkArtifact();
}
