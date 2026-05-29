/**
 * CLI entrypoint for the stream/pagination benchmark.
 *
 * Usage (after `npm run build`, which emits `dist/bench/run.js`):
 *
 *   node dist/bench/run.js
 *   node dist/bench/run.js --features 100000 --pages 1000,5000,20000 --latency 1
 *   node dist/bench/run.js --json
 *
 * Flags:
 *   --features <n>     fixture size (default 50000)
 *   --pages <csv>      comma-separated page sizes to sweep (default 500,2000,10000)
 *   --latency <ms>     artificial per-page transport latency (default 0)
 *   --no-geometry      drop geometry from the drained pages
 *   --json             emit the raw metrics report as JSON instead of a table
 */
import { type StreamBenchOptions, formatReport, runStreamBench } from "./stream-bench.js";

function parseArgs(argv: readonly string[]): { options: StreamBenchOptions; json: boolean } {
  const options: StreamBenchOptions = {};
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--features":
        options.featureCount = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--pages":
        options.pageSizes = (argv[++i] ?? "")
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        break;
      case "--latency":
        options.pageLatencyMs = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--no-geometry":
        options.returnGeometry = false;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { options, json };
}

async function main(): Promise<void> {
  const { options, json } = parseArgs(process.argv.slice(2));
  const report = await runStreamBench(options);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`stream-bench failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
