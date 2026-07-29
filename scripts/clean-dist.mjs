#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "..", "dist");
fs.rmSync(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
