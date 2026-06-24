import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // The certification CLI is a thin bin entry (arg parsing + process exit)
      // exercised end-to-end by the `node dist/src/certification/cli.js` step in
      // the `test:certification` script; its logic lives in run.ts/certifier.ts.
      exclude: ["dist/**", "src/certification/cli.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
