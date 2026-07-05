// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { HonuaProvider, useQuery, useRealtime } from "../../src/react/index.js";
import { controllableSource, fakeClient, makeResult } from "./support.js";

afterEach(cleanup);

describe("StrictMode safety", () => {
  it("resolves a query and leaves exactly one live request after the double-mount", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();

    function Panel() {
      const { status, data } = useQuery(ctrl.source, { where: "1=1" });
      return <span data-testid="panel">{status === "success" ? String(data?.features.length) : status}</span>;
    }

    render(
      <StrictMode>
        <HonuaProvider client={client}>
          <Panel />
        </HonuaProvider>
      </StrictMode>,
    );

    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }]));
    });
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("1"));

    // The synthetic StrictMode unmount aborted its request; only one live
    // (non-aborted) request should remain — no duplicate subscription leaked.
    const liveCalls = ctrl.calls.filter((call) => !call.aborted());
    expect(liveCalls).toHaveLength(1);
  });

  it("balances realtime subscribe/unsubscribe across StrictMode double-invoke", async () => {
    let active = 0;
    let opened = 0;

    function Live() {
      useRealtime(() => {
        active += 1;
        opened += 1;
        return () => {
          active -= 1;
        };
      }, []);
      return <span data-testid="live">on</span>;
    }

    const view = render(
      <StrictMode>
        <Live />
      </StrictMode>,
    );

    // After mount, exactly one subscription is active despite the double-invoke.
    await waitFor(() => expect(screen.getByTestId("live").textContent).toBe("on"));
    expect(active).toBe(1);
    expect(opened).toBeGreaterThanOrEqual(1);

    view.unmount();
    expect(active).toBe(0);
  });

  it("re-subscribes realtime when deps change and cleans up the old subscription", () => {
    const log: string[] = [];

    function Live({ channel }: { channel: string }) {
      useRealtime(() => {
        log.push(`open:${channel}`);
        return () => log.push(`close:${channel}`);
      }, [channel]);
      return null;
    }

    function Host() {
      const [channel, setChannel] = useState("a");
      return (
        <>
          <button type="button" data-testid="swap" onClick={() => setChannel("b")}>
            swap
          </button>
          <Live channel={channel} />
        </>
      );
    }

    // Not under StrictMode here to keep the open/close ledger easy to read.
    render(<Host />);
    act(() => {
      screen.getByTestId("swap").click();
    });
    expect(log).toContain("open:a");
    expect(log).toContain("close:a");
    expect(log).toContain("open:b");
  });
});
