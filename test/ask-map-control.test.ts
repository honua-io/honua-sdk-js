import { describe, expect, it, vi } from "vitest";
import { HonuaAskMapClarification, createAskMapSession, createNlMapControl } from "../src/nl-map-control/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const completion = { toolCalls: [{ name: "runWidgetQuery", arguments: { sourceId: "incidents", kind: "count" } }] };
function setup(options: { llm?: () => Promise<typeof completion>; query?: () => Promise<unknown> } = {}) {
  let context = { sourceVersion: "v1", viewport: [0, 0, 1, 1] };
  const apply = vi.fn(() => ({ count: 3 }));
  const query = vi.fn(async () => ({
    sourceId: "incidents",
    kind: "count" as const,
    data: (await options.query?.()) ?? { count: 3 },
  }));
  const session = createAskMapSession({
    context: () => context,
    createControl: () =>
      createNlMapControl({
        tools: {
          runtime: { listSources: () => [{ id: "incidents", capabilities: ["query"] }], runWidgetQuery: query },
          tools: ["runWidgetQuery"],
        },
        llm: options.llm ?? (async () => completion),
      }),
    review: () => ({ summary: "Three fixtures", details: {} }),
    apply,
    onState: () => {},
    timeoutMs: 1000,
  });
  return {
    session,
    apply,
    query,
    change: () => {
      context = { ...context, sourceVersion: "v2" };
    },
  };
}
describe("Ask this map review lifecycle", () => {
  it("requires review and consumes an execution once, even for concurrent clicks", async () => {
    const wait = deferred<unknown>();
    const { session, query, apply } = setup({ query: () => wait.promise });
    await session.execute();
    expect(query).not.toHaveBeenCalled();
    await session.propose("show incidents");
    expect(session.state.phase).toBe("review");
    const first = session.execute();
    await session.execute();
    wait.resolve({ count: 3 });
    await first;
    expect(query).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("never replaces a newer proposal with an old callback that ignores cancellation", async () => {
    const old = deferred<typeof completion>();
    let calls = 0;
    const { session } = setup({ llm: () => (++calls === 1 ? old.promise : Promise.resolve(completion)) });
    const first = session.propose("old");
    await vi.waitFor(() => expect(calls).toBe(1));
    await session.propose("new");
    old.resolve(completion);
    await first;
    expect(session.state.plan?.instruction).toBe("new");
  });
  it("preserves results when cancelled during an uncooperative query", async () => {
    const wait = deferred<unknown>();
    const { session, apply, query } = setup({ query: () => wait.promise });
    await session.propose("show");
    const running = session.execute();
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    session.cancel();
    wait.resolve({ count: 4 });
    await running;
    expect(apply).not.toHaveBeenCalled();
    expect(session.state.phase).toBe("cancelled");
  });
  it("invalidates a changed source before wire execution and after an in-flight result", async () => {
    const first = setup();
    await first.session.propose("show");
    first.change();
    await first.session.execute();
    expect(first.query).not.toHaveBeenCalled();
    const wait = deferred<unknown>();
    const second = setup({ query: () => wait.promise });
    await second.session.propose("show");
    const running = second.session.execute();
    await vi.waitFor(() => expect(second.query).toHaveBeenCalled());
    second.change();
    wait.resolve({});
    await running;
    expect(second.apply).not.toHaveBeenCalled();
    expect(second.session.state.phase).toBe("idle");
  });
  it("surfaces clarification without a query or application", async () => {
    const { session, query, apply } = setup({
      llm: async () => {
        throw new HonuaAskMapClarification("Which location?");
      },
    });
    await session.propose("nearby");
    expect(session.state.phase).toBe("clarification");
    expect(query).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("bounds a callback that never returns", async () => {
    vi.useFakeTimers();
    try {
      const { session } = setup({ llm: () => new Promise(() => {}) });
      const run = session.propose("show");
      await vi.advanceTimersByTimeAsync(1001);
      await run;
      expect(session.state.phase).toBe("failed");
      expect(session.state.message).toContain("1000 ms");
    } finally {
      vi.useRealTimers();
    }
  });
  it("checks host admission on corrections and rechecks before execution", async () => {
    let permitted = false;
    const query = vi.fn(async () => ({ sourceId: "incidents", kind: "count" as const, data: {} }));
    const llm = vi.fn(async () => completion);
    const control = createNlMapControl({
      tools: { runtime: { runWidgetQuery: query }, tools: ["runWidgetQuery"] },
      llm,
      policy: { maxSelfCorrections: 1 },
      validateStep: () => (permitted ? [] : [{ code: "capability-gap", message: "Schema changed" }]),
    });
    await expect(control.propose("show")).rejects.toThrow("No valid plan");
    expect(llm).toHaveBeenCalledTimes(2);
    permitted = true;
    const plan = await control.propose("show");
    permitted = false;
    await expect(control.execute(plan)).rejects.toThrow("Host rejected");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("Ask this map runtime cancellation", () => {
  it("aborts the same signal supplied to the host runtime after review", async () => {
    let hostSignal: AbortSignal | undefined;
    const started = deferred<void>();
    const session = createAskMapSession({
      context: () => ({ sourceVersion: "v1" }),
      createControl(_context, signal) {
        hostSignal = signal;
        return createNlMapControl({
          tools: {
            runtime: {
              async runWidgetQuery() {
                started.resolve();
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                return { sourceId: "incidents", kind: "count", data: {} };
              },
            },
            tools: ["runWidgetQuery"],
          },
          llm: async () => completion,
        });
      },
      review: () => ({ summary: "Review", details: {} }),
      apply: () => {
        throw new Error("Cancelled results must never apply");
      },
      onState: () => {},
    });
    await session.propose("show");
    const execute = session.execute();
    await started.promise;
    session.cancel();
    await execute;
    expect(hostSignal?.aborted).toBe(true);
    expect(session.state.phase).toBe("cancelled");
  });
});
