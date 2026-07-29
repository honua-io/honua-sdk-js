#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { windowsScriptInvocation } from "./windows-path-cli.mjs";

export const PATH_CLI_OWNER_GATE_FLAG = "--honua-wait-for-owner";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 127;
}

async function waitForOwnerLaunch() {
  if (typeof process.send !== "function") {
    throw new Error("Windows PATH CLI owner gate requires an IPC channel");
  }
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("Windows PATH CLI owner disconnected before launch"));
    };
    const onMessage = (message) => {
      if (message?.kind !== "launch") return;
      cleanup();
      resolve();
    };
    process.once("disconnect", onDisconnect);
    process.on("message", onMessage);
  });
  process.disconnect();
}

export async function main(argv = process.argv.slice(2)) {
  const ownerGated = argv[0] === PATH_CLI_OWNER_GATE_FLAG;
  const commandArgs = ownerGated ? argv.slice(1) : argv;
  const [resolvedCommand, ...args] = commandArgs;
  if (!resolvedCommand) {
    fail("The Windows PATH CLI runner requires a resolved command");
    return;
  }
  if (ownerGated) await waitForOwnerLaunch();
  const invocation = /\.(?:cmd|bat)$/i.test(resolvedCommand)
    ? windowsScriptInvocation(resolvedCommand, args)
    : { command: resolvedCommand, args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
  await new Promise((resolve) => {
    child.once("error", (error) => {
      fail(error.message);
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`Windows PATH command terminated by ${signal}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 1;
      }
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.stack : String(error)));
}
