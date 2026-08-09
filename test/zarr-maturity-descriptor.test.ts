import fs from "node:fs";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const descriptorPath = path.join(root, "docs", "data", "zarr-client-maturity.v1.json");
const schemaPath = path.join(root, "docs", "data", "zarr-client-maturity.v1.schema.json");
const decisionPath = path.join(root, "docs", "decisions", "zarr-client-maturity.md");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readDescriptor(): Record<string, any> {
  return readJson(descriptorPath) as Record<string, any>;
}

describe("Zarr client maturity descriptor", () => {
  it("validates the versioned descriptor against its schema", () => {
    const schema = readJson(schemaPath);
    const descriptor = readDescriptor();
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    expect(validate(descriptor), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("keeps server, client, and sample maturity separate", () => {
    const descriptor = readDescriptor();

    expect(descriptor.visibility.status).toBe("internal-only");
    expect(descriptor.maturity.server.status).toBe("implementation-evidenced");
    expect(descriptor.maturity.client.status).toBe("unavailable");
    expect(descriptor.maturity.sample.status).toBe("withheld");
  });

  it("records registration, coverage, datacube tile, and WCS evidence boundaries", () => {
    const descriptor = readDescriptor();
    const surfaces = new Map(descriptor.serverEvidence.map((surface: any) => [surface.id, surface]));

    expect([...surfaces.keys()]).toEqual(["registration", "coverage", "datacube-tile", "wcs"]);
    for (const id of surfaces.keys()) {
      expect(surfaces.get(id).boundary).toBeTruthy();
      expect(surfaces.get(id).evidence.length).toBeGreaterThan(0);
    }
  });

  it("requires missing fixture and live gates before publication", () => {
    const descriptor = readDescriptor();

    for (const gateGroup of Object.values(descriptor.evidenceGates) as Array<Array<{ status: string }>>) {
      expect(gateGroup.length).toBeGreaterThan(0);
      expect(gateGroup.every((gate) => gate.status === "missing")).toBe(true);
    }
  });

  it("documents future responsibilities without exposing code or a sample", () => {
    const descriptor = readDescriptor();
    const packageJson = readJson(path.join(root, "package.json")) as { exports?: Record<string, unknown> };
    const operationIds = descriptor.futureApiShape.operations.map((operation: any) => operation.id);

    expect(descriptor.futureApiShape.exposed).toBe(false);
    expect(operationIds).toEqual(["metadata", "slice", "tile"]);
    expect(packageJson.exports?.["./zarr"]).toBeUndefined();
    expect(fs.existsSync(path.join(root, "src", "zarr"))).toBe(false);
    expect(fs.existsSync(path.join(root, "examples", "zarr-basic"))).toBe(false);
    expect(fs.existsSync(path.join(root, "playgrounds", "zarr-basic"))).toBe(false);
  });

  it("keeps the architecture page aligned with the governed boundary", () => {
    const doc = fs.readFileSync(decisionPath, "utf8");

    for (const requiredText of [
      "## Reconciled Server Evidence",
      "## Server Contract Bounds",
      "## Why This Stays Internal",
      "## Required Evidence Gates",
      "## Future API Shape, Not An API",
      "client implementation",
      "positive public live Zarr canary",
    ]) {
      expect(doc).toContain(requiredText);
    }
  });
});
