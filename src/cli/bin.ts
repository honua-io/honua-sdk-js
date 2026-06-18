#!/usr/bin/env node
/**
 * Executable shim for the `honua` CLI. Delegates to {@link run} and translates
 * its resolved exit code into a process exit.
 *
 * @packageDocumentation
 */

import { run } from "./main.js";

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
