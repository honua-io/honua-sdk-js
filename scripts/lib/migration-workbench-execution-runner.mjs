import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { snapshotDeniedNetworkAttempts } from "./migration-workbench-network-guard.mjs";

const targetPath = process.argv[2];
if (!targetPath) {
  throw new Error("The isolated migration target runner requires a target module path.");
}

const runnerNonce = fs.readFileSync(0, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(runnerNonce)) {
  throw new Error("The isolated migration target runner received an invalid one-time protocol nonce.");
}

const generatedModule = await import(pathToFileURL(targetPath).href);
const serializedValue = JSON.stringify(generatedModule.default);
if (serializedValue === undefined) {
  throw new Error("The generated migration target did not export a JSON-serializable default value.");
}

const networkAttempts = snapshotDeniedNetworkAttempts();
if (networkAttempts.length > 0) {
  throw new Error(
    `Generated migration target attempted ${networkAttempts.length} denied network operation(s): ${networkAttempts.join(", ")}.`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    protocol: "honua.migration-workbench.runner.v1",
    nonce: runnerNonce,
    value: JSON.parse(serializedValue),
    networkAttempts: [...networkAttempts],
  })}\n`,
);
