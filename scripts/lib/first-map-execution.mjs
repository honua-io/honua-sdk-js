import assert from "node:assert/strict";
import os from "node:os";
import { chromium } from "@playwright/test";
import { startQuickstartFixtureServer } from "../../examples/maplibre-quickstart/mock-server.mjs";

// CPU costs from cold browser contexts through the first usable map frame. These
// are fixture performance measurements, never live-server certification evidence.
export async function measureFirstMapExecution(staticRoot, { repetitions = 3, cpuThrottle = 4 } = {}) {
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 5, "execution measurement requires 1–5 runs");
  assert.ok(Number.isFinite(cpuThrottle) && cpuThrottle >= 1 && cpuThrottle <= 6, "CPU throttle must be between 1 and 6");
  const fixture = await startQuickstartFixtureServer({ build: false, staticRoot });
  let browser;
  try {
    browser = await chromium.launch();
    const samples = [];
    for (let run = 0; run < repetitions; run++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      try {
        const page = await context.newPage();
        const failures = [];
        page.on("pageerror", (error) => failures.push(error.message));
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          return /^https?:$/.test(url.protocol) && url.origin !== new URL(fixture.url).origin ? route.abort("blockedbyclient") : route.continue();
        });
        const session = await context.newCDPSession(page);
        await session.send("Network.enable");
        await session.send("Network.setCacheDisabled", { cacheDisabled: true });
        await session.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
        await session.send("Performance.enable", { timeDomain: "threadTicks" });
        const events = [];
        let traceOverflow = false;
        session.on("Tracing.dataCollected", ({ value }) => {
          if (events.length + value.length >= 100_000) traceOverflow = true;
          else events.push(...value);
        });
        await session.send("Tracing.start", { categories: "v8,devtools.timeline", transferMode: "ReportEvents" });
        const started = await session.send("Performance.getMetrics");
        await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
        await page.locator("#map-overlay[data-state=ready]").waitFor({ timeout: 60_000 });
        assert.deepEqual(failures, [], "First Map must render successfully before execution costs can pass");
        const ended = await session.send("Performance.getMetrics");
        const completed = new Promise((resolve) => session.once("Tracing.tracingComplete", resolve));
        await session.send("Tracing.end");
        let traceTimer;
        try {
          await Promise.race([completed, new Promise((_, reject) => {
            traceTimer = setTimeout(() => reject(new Error("First Map CPU trace did not finish within 20 seconds")), 20_000);
          })]);
        } finally { clearTimeout(traceTimer); }
        assert.ok(!traceOverflow, "First Map CPU trace exceeded its bounded event budget");
        const metric = (payload, name) => payload.metrics.find((entry) => entry.name === name)?.value;
        const scriptMs = 1_000 * (metric(ended, "ScriptDuration") - metric(started, "ScriptDuration"));
        assert.ok(Number.isFinite(scriptMs) && scriptMs > 0, "Chromium did not report script CPU time");
        // Record named compile/parse spans separately. Nested spans are merged per
        // thread so the parse measure does not double-count compiler internals.
        const compile = events.filter((event) => event.ph === "X" && /^v8[.:]/i.test(event.name) && /(?:compile|parse)/i.test(event.name) && !/waiting/i.test(event.name) && event.dur > 0);
        const threads = new Map();
        for (const event of compile) {
          const key = `${event.pid}:${event.tid}`;
          const spans = threads.get(key) ?? [];
          spans.push([event.ts, event.ts + event.dur]);
          threads.set(key, spans);
        }
        let compileMicroseconds = 0;
        for (const spans of threads.values()) {
          spans.sort((a, b) => a[0] - b[0]);
          let interval;
          for (const span of spans) {
            if (interval && span[0] <= interval[1]) interval[1] = Math.max(interval[1], span[1]);
            else { if (interval) compileMicroseconds += interval[1] - interval[0]; interval = [...span]; }
          }
          if (interval) compileMicroseconds += interval[1] - interval[0];
        }
        assert.ok(compile.length > 0, "Chromium trace did not report parse or compilation spans");
        samples.push({ scriptCpuMs: scriptMs, parseCompileMs: compileMicroseconds / 1_000,
          compileEventNames: [...new Set(compile.map((event) => event.name))].sort() });
      } finally {
        await context.close();
      }
    }
    return { scope: "closed fixture; cold browser contexts through first usable map frame", browser: browser.version(), node: process.version,
      host: { platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model }, cpuThrottle, repetitions,
      metrics: { scriptCpuMs: "page main-thread Chromium Performance ScriptDuration in threadTicks; includes mount execution, excludes worker script CPU",
        parseCompileMs: "union of parse/compile trace intervals per thread, including background compilation, excluding named waiting spans; elapsed span time" }, samples };
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
