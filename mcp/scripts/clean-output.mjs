#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MCP_OUTPUT_DIRECTORIES = Object.freeze(["dist", "coverage"]);

const MCP_ROOT = path.resolve(import.meta.dirname, "..");

export function cleanMcpOutputs(root = MCP_ROOT) {
  const resolvedRoot = path.resolve(root);
  for (const name of MCP_OUTPUT_DIRECTORIES) {
    const target = path.resolve(resolvedRoot, name);
    if (path.dirname(target) !== resolvedRoot || path.basename(target) !== name) {
      throw new Error(`Unsafe MCP output target: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanMcpOutputs();
}
