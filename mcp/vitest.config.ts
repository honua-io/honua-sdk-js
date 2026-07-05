import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**"],
    // Certification integration tests stand up a real streamable-HTTP mock
    // upstream and round-trip the full operator catalog over HTTP/stdio.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "dist/**",
        // Thin bin entries (arg parsing + process exit) exercised end-to-end by the
        // `node dist/src/.../cli.js` steps in the test:certification / test:eval
        // scripts; their logic lives in run.ts/certifier.ts and runner.ts/report.ts.
        "src/certification/cli.ts",
        "src/eval/cli.ts",
        // Type-only declarations — no runtime code to cover.
        "src/eval/types.ts",
        // Live cross-model driver adapters that make real Anthropic/OpenAI/Bedrock
        // calls. The cross-model eval only runs with real API keys / AWS creds (live
        // runs are deferred, honua-server #1956); the deterministic driver is the
        // offline CI control, and the eval pipeline (runner/grade/report) is
        // unit-tested through it. The pure mapping helpers in bedrock.ts are still
        // unit-tested directly (test/eval/bedrock.test.ts), but the network-bound
        // runWorkflow path cannot be covered without real calls.
        "src/eval/drivers/anthropic.ts",
        "src/eval/drivers/openai.ts",
        "src/eval/drivers/bedrock.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
