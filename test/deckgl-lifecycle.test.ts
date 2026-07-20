import { describe, expect, it, vi } from "vitest";

import { type DeckGlDisposalHandle, combineDeckGlDisposal } from "../src/deckgl/index.js";

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
