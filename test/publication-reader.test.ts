import { describe, expect, it } from "vitest";

import { HonuaAbortError } from "../src/core/errors.js";
import { sharedTask } from "../src/publication/abort.js";
import { artifactRangeReader } from "../src/publication/range-reader.js";

const URL_UNDER_TEST = "https://data.example.test/parcels.parquet";
const FILE_BYTES = 1_000;

function answering(status: number, headers: Record<string, string>, body = new Uint8Array(10)): typeof fetch {
  return async () => new Response(body, { status, headers });
}

function rangeOf(start: number, end: number): Record<string, string> {
  return { "content-range": `bytes ${start}-${end}/${FILE_BYTES}`, "content-length": String(end - start + 1) };
}

describe("artifact range reader", () => {
  it("returns exactly the requested bytes of a 206", async () => {
    const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(206, rangeOf(10, 19)));
    const meter = { bytes: 0 };
    const body = await reader.view(undefined, meter).slice(10, 20);
    expect(body.byteLength).toBe(10);
    expect(meter.bytes).toBe(10);
  });

  it("rejects a 206 for other bytes, another file size or an unverifiable range as an artifact mismatch", async () => {
    const lengthOnly = { "content-length": "10" };
    for (const headers of [
      rangeOf(0, 9),
      { ...rangeOf(10, 19), "content-range": "bytes 10-19/2000" },
      { ...rangeOf(10, 19), "content-range": "bytes 10-19/*" },
      lengthOnly,
    ]) {
      const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(206, headers));
      await expect(reader.view().slice(10, 20)).rejects.toMatchObject({ code: "artifact-mismatch" });
    }
  });

  it("cancels an oversized range stream before reading the remaining body", async () => {
    for (const length of [undefined, "10"]) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            if (pulls > 1) throw new Error("The reader consumed the remaining oversized body");
            controller.enqueue(new Uint8Array(11));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const headers: Record<string, string> = { "content-range": "bytes 10-19/1000" };
      if (length !== undefined) headers["content-length"] = length;
      const reader = artifactRangeReader(
        URL_UNDER_TEST,
        FILE_BYTES,
        async () => new Response(body, { status: 206, headers }),
      );
      await expect(reader.view().slice(10, 20)).rejects.toMatchObject({ code: "artifact-mismatch" });
      expect(pulls).toBe(1);
      expect(cancelled).toBe(true);
    }
  });

  it("refuses a 200 for part of the file as a host without byte ranges", async () => {
    const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(200, {}, new Uint8Array(FILE_BYTES)));
    await expect(reader.view().slice(10, 20)).rejects.toMatchObject({
      code: "query-budget-exceeded",
      detail: { reason: "range-not-served", fileBytes: FILE_BYTES },
    });
  });

  it("accepts a 200 when the whole file was requested", async () => {
    const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(200, {}, new Uint8Array(FILE_BYTES)));
    expect((await reader.view().slice(0, FILE_BYTES)).byteLength).toBe(FILE_BYTES);
  });

  it("reports a missing or refused artifact with its HTTP status, and a short file as a mismatch", async () => {
    for (const status of [403, 404, 503]) {
      const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(status, {}));
      await expect(reader.view().slice(10, 20)).rejects.toMatchObject({
        code: "artifact-unavailable",
        detail: { status },
      });
    }
    const short = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, answering(416, {}));
    await expect(short.view().slice(10, 20)).rejects.toMatchObject({ code: "artifact-mismatch" });
  });

  it("serves a repeated small read from memory without counting it again", async () => {
    let requests = 0;
    const counting: typeof fetch = async () => {
      requests++;
      return new Response(new Uint8Array(10), { status: 206, headers: rangeOf(10, 19) });
    };
    const reader = artifactRangeReader(URL_UNDER_TEST, FILE_BYTES, counting);
    const meter = { bytes: 0 };
    await reader.view(undefined, meter).slice(10, 20);
    await reader.view(undefined, meter).slice(10, 20);
    expect(requests).toBe(1);
    expect(meter.bytes).toBe(10);
  });
});

describe("shared task", () => {
  function deferredTask() {
    const runs: AbortSignal[] = [];
    let finish: (value: string) => void = () => undefined;
    const task = sharedTask((signal) => {
      runs.push(signal);
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    return { task, runs, finish: (value: string) => finish(value) };
  }

  it("runs once for concurrent callers and keeps running while one caller still waits", async () => {
    const { task, runs, finish } = deferredTask();
    const cancelled = new AbortController();
    const first = task(cancelled.signal);
    const second = task();
    cancelled.abort();
    await expect(first).rejects.toBeInstanceOf(HonuaAbortError);
    finish("footer");
    await expect(second).resolves.toBe("footer");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.aborted).toBe(false);
  });

  it("cancels the run when every caller cancels, and starts a new run for the next caller", async () => {
    const { task, runs, finish } = deferredTask();
    const one = new AbortController();
    const two = new AbortController();
    const first = task(one.signal);
    const second = task(two.signal);
    one.abort();
    two.abort();
    await expect(first).rejects.toBeInstanceOf(HonuaAbortError);
    await expect(second).rejects.toBeInstanceOf(HonuaAbortError);
    expect(runs[0]?.aborted).toBe(true);
    const third = task();
    finish("again");
    await expect(third).resolves.toBe("again");
    expect(runs).toHaveLength(2);
  });

  it("keeps a settled result when a caller cancels afterwards", async () => {
    const { task, runs, finish } = deferredTask();
    const controller = new AbortController();
    const first = task(controller.signal);
    finish("done");
    await expect(first).resolves.toBe("done");
    controller.abort();
    await expect(task()).resolves.toBe("done");
    expect(runs).toHaveLength(1);
  });
});
