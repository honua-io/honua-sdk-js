import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const MAX_CAPTURE_BYTES = 512 * 1024;
const STARTUP_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const FIXTURE_TIMEOUT_MS = STARTUP_TIMEOUT_MS + FETCH_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS + 5_000;
const FIXTURES = [
  {
    name: "edit workflow",
    file: "examples/edit-workflow-demo/mock-server.mjs",
    marker: "editWorkflowUrl",
  },
  {
    name: "sketch editing",
    file: "examples/sketch-editing/mock-server.mjs",
    marker: "sketchEditingUrl",
  },
  {
    name: "web components",
    file: "examples/web-components-basic/mock-server.mjs",
    marker: "webComponentsUrl",
  },
];

function captureStartup(child, fixture) {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout;

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const append = (current, chunk, label) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
        fail(new Error(`${fixture.name} ${label} exceeded ${MAX_CAPTURE_BYTES} bytes`));
      }
      return next;
    };
    const inspectMarker = () => {
      const match = stdout.match(new RegExp(`${fixture.marker}=(http://127\\.0\\.0\\.1:\\d+)`));
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, "stdout");
      inspectMarker();
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(
        new Error(
          `${fixture.name} exited before startup (code=${code ?? "none"}, signal=${signal ?? "none"})\n${stdout}${stderr}`,
        ),
      );
    });
    timeout = setTimeout(() => {
      fail(new Error(`${fixture.name} did not reach startup within ${STARTUP_TIMEOUT_MS}ms\n${stdout}${stderr}`));
    }, STARTUP_TIMEOUT_MS);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`fixture child ${child.pid} did not exit after termination`)),
          SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test(
  "native Windows fixture servers build, bind, and serve without hanging",
  { skip: process.platform !== "win32", timeout: FIXTURES.length * FIXTURE_TIMEOUT_MS + 5_000 },
  async (t) => {
    for (const fixture of FIXTURES) {
      await t.test(fixture.name, { timeout: FIXTURE_TIMEOUT_MS }, async () => {
        const child = spawn(process.execPath, [path.join(PROJECT_ROOT, fixture.file)], {
          cwd: PROJECT_ROOT,
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        try {
          const url = await captureStartup(child, fixture);
          const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          assert.equal(response.status, 200);
          assert.match(await response.text(), /<!doctype html/i);
        } finally {
          await stopChild(child);
        }
      });
    }
  },
);
