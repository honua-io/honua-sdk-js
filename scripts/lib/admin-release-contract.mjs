import { createHash } from "node:crypto";

// This verifies the pinned artifact and route inventory, not live authorization
// or request/response schema compatibility. Those require candidate qualification.
export function assertReleaseAdminContract(source, clientDocument, releaseText) {
  if (!/^[0-9a-f]{40}$/.test(source.releaseManifestServerSha ?? "")) {
    throw new Error("Release Admin contract requires an immutable server SHA.");
  }
  if (!/^[0-9a-f]{64}$/.test(source.releaseManifestSpecSha256 ?? "")) {
    throw new Error("Release Admin contract requires a pinned OpenAPI SHA-256.");
  }
  const digest = createHash("sha256").update(releaseText).digest("hex");
  if (digest !== source.releaseManifestSpecSha256) {
    throw new Error(`Release Admin OpenAPI digest mismatch: expected ${source.releaseManifestSpecSha256}, received ${digest}.`);
  }
  const releaseOperations = inventory(JSON.parse(releaseText));
  if (releaseOperations.size !== source.releaseManifestOperationCount) {
    throw new Error(`Release Admin operation count mismatch: expected ${source.releaseManifestOperationCount}, received ${releaseOperations.size}.`);
  }
  for (const [id, route] of inventory(clientDocument)) {
    if (releaseOperations.get(id) !== route) {
      throw new Error(`Release Admin operation regression: ${id} requires ${route}, received ${releaseOperations.get(id) ?? "missing"}.`);
    }
  }
  if (source.releaseManifestStatus !== "compatible") {
    throw new Error("Verified release Admin inventory requires releaseManifestStatus=compatible.");
  }
}

function inventory(document) {
  const operations = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      const operation = item[method];
      if (!operation) continue;
      const id = operation.operationId;
      if (typeof id !== "string" || !id || operations.has(id)) {
        throw new Error(`Release Admin inventory has a missing or duplicate operationId at ${method.toUpperCase()} ${path}.`);
      }
      operations.set(id, `${method.toUpperCase()} ${path}`);
    }
  }
  if (operations.size === 0) throw new Error("Release Admin inventory is empty.");
  return operations;
}
