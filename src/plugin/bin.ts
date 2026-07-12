#!/usr/bin/env node
/**
 * Executable shim for the `honua-plugin-certify` certification kit. Wires the
 * Node filesystem and process streams into {@link runPluginCertificationCli}
 * and translates its resolved exit code into a process exit.
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { runPluginCertificationCli } from "./cli.js";

runPluginCertificationCli(process.argv.slice(2), {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 2;
  });
