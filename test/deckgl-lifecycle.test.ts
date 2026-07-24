import { describe, expect, it, vi } from "vitest";

import {
  type DeckGlContextLossTarget,
  type DeckGlDisposalHandle,
  bindDeckGlContextLossRecovery,
  combineDeckGlDisposal,
} from "../src/deckgl/index.js";

/** A minimal `EventTarget`-shaped fake canvas — vitest runs in a Node environment with no DOM. */
class FakeCanvas implements DeckGlContextLossTarget {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeContextEvent(): Event {
  let defaultPrevented = false;
  return {
    type: "webglcontextlost",
    preventDefault() {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as unknown as Event;
}

function handle(dispose: () => void): DeckGlDisposalHandle {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    dispose() {
      dispose();
      disposed = true;
    },
  };
}

describe("combineDeckGlDisposal", () => {
  it("disposes every handle in reverse bind order exactly once", () => {
    const order: string[] = [];
    const a = handle(() => order.push("a"));
    const b = handle(() => order.push("b"));
    const c = handle(() => order.push("c"));
    const combined = combineDeckGlDisposal(a, b, c);

    expect(combined.disposed).toBe(false);
    combined.dispose();

    expect(order).toEqual(["c", "b", "a"]);
    expect(combined.disposed).toBe(true);
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
    expect(c.disposed).toBe(true);

    combined.dispose();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("disposes every handle even when one throws, then reports dispose-failed and stays retryable", () => {
    const disposedFlags = { a: false, c: false };
    const a: DeckGlDisposalHandle = {
      get disposed() {
        return disposedFlags.a;
      },
      dispose() {
        disposedFlags.a = true;
      },
    };
    const failing = vi.fn(() => {
      throw new Error("host gone");
    });
    const b: DeckGlDisposalHandle = { disposed: false, dispose: failing };
    const c: DeckGlDisposalHandle = {
      get disposed() {
        return disposedFlags.c;
      },
      dispose() {
        disposedFlags.c = true;
      },
    };
    const combined = combineDeckGlDisposal(a, b, c);

    expect(() => combined.dispose()).toThrowError(
      expect.objectContaining({ code: "dispose-failed", detail: { failures: 1, total: 3 } }),
    );
    expect(combined.disposed).toBe(false);
    expect(disposedFlags.a).toBe(true);
    expect(disposedFlags.c).toBe(true);
    expect(failing).toHaveBeenCalledOnce();
  });

  it("rejects a value that is not a DeckGlDisposalHandle", () => {
    expect(() => combineDeckGlDisposal({} as DeckGlDisposalHandle)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("composes with zero handles as a no-op", () => {
    const combined = combineDeckGlDisposal();
    expect(() => combined.dispose()).not.toThrow();
    expect(combined.disposed).toBe(true);
  });
});

describe("bindDeckGlContextLossRecovery", () => {
  it("cancels the loss event's default action and forwards both events", () => {
    const canvas = new FakeCanvas();
    const lost = vi.fn();
    const restored = vi.fn();
    const binding = bindDeckGlContextLossRecovery(canvas, { onLost: lost, onRestored: restored });

    expect(binding.disposed).toBe(false);
    expect(canvas.listenerCount("webglcontextlost")).toBe(1);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(1);

    const lossEvent = fakeContextEvent();
    canvas.dispatch("webglcontextlost", lossEvent);
    expect((lossEvent as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
    expect(lost).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledWith(lossEvent);

    const restoredEvent = fakeContextEvent();
    canvas.dispatch("webglcontextrestored", restoredEvent);
    expect(restored).toHaveBeenCalledOnce();
    expect(restored).toHaveBeenCalledWith(restoredEvent);
  });

  it("removes both listeners idempotently on dispose", () => {
    const canvas = new FakeCanvas();
    const lost = vi.fn();
    const binding = bindDeckGlContextLossRecovery(canvas, { onLost: lost });

    binding.dispose();
    expect(binding.disposed).toBe(true);
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);

    canvas.dispatch("webglcontextlost", fakeContextEvent());
    expect(lost).not.toHaveBeenCalled();

    // Idempotent: a second dispose() is a no-op, not an error.
    expect(() => binding.dispose()).not.toThrow();
  });

  it("tolerates missing callbacks", () => {
    const canvas = new FakeCanvas();
    const binding = bindDeckGlContextLossRecovery(canvas);
    expect(() => canvas.dispatch("webglcontextlost", fakeContextEvent())).not.toThrow();
    expect(() => canvas.dispatch("webglcontextrestored", fakeContextEvent())).not.toThrow();
    binding.dispose();
  });

  it("rejects a target that is not a canvas-like EventTarget", () => {
    expect(() => bindDeckGlContextLossRecovery({} as unknown as DeckGlContextLossTarget)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
    expect(() => bindDeckGlContextLossRecovery(null as unknown as DeckGlContextLossTarget)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});
