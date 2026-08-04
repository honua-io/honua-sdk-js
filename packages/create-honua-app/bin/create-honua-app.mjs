#!/usr/bin/env node

// Entry point for `npm create honua-app` / `npx create-honua-app`.

import { run } from "../lib/cli.mjs";

process.exitCode = run(process.argv.slice(2));
