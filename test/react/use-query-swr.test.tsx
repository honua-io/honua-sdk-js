// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaProvider, HonuaQueryCache, useQuery } from "../../src/react/index.js";
import { controllableSource, fakeClient, makeResult } from "./support.js";

afterEach(cleanup);

class Boundary extends Component<{ children?: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const name = this.state.error instanceof Error ? this.state.error.name : "unknown";
      return <span data-testid="boundary">{name}</span>;
    }
    return this.props.children;
  }
}

describe("useQuery stale-while-revalidate", () => {
  it("serves cached data and revalidates in the background when stale", async () => {
    const { client } = fakeClient();
    const cache = new HonuaQueryCache();
    const ctrl = controllableSource();

    function Panel() {
      const { data, isFetching } = useQuery(ctrl.source, { where: "1=1" }, { staleTimeMs: 0 });
      return (
        <span data-testid="panel">
          {data ? String(data.features.length) : "empty"}:{isFetching ? "fetching" : "settled"}
        </span>
      );
    }

    const first = render(
      <HonuaProvider client={client} cache={cache}>
        <Panel />
      </HonuaProvider>,
    );
    await act(async () => ctrl.resolveLatest(makeResult([{ id: 1 }])));
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("1:settled"));
    expect(ctrl.queryCount()).toBe(1);
    first.unmount();

    // Remount with the shared cache: cached data renders immediately while a
    // background revalidation runs (staleTimeMs 0 ⇒ always stale).
    render(
      <HonuaProvider client={client} cache={cache}>
        <Panel />
      </HonuaProvider>,
    );
    expect(screen.getByTestId("panel").textContent).toBe("1:fetching");
    expect(ctrl.queryCount()).toBe(2);

    await act(async () => ctrl.resolveLatest(makeResult([{ id: 1 }, { id: 2 }])));
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("2:settled"));
  });

  it("does not revalidate fresh data inside the stale window", async () => {
    const { client } = fakeClient();
    const cache = new HonuaQueryCache();
    const ctrl = controllableSource();

    function Panel() {
      const { data } = useQuery(ctrl.source, { where: "1=1" }, { staleTimeMs: 60_000 });
      return <span data-testid="panel">{data ? String(data.features.length) : "empty"}</span>;
    }

    const first = render(
      <HonuaProvider client={client} cache={cache}>
        <Panel />
      </HonuaProvider>,
    );
    await act(async () => ctrl.resolveLatest(makeResult([{ id: 1 }])));
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("1"));
    first.unmount();

    render(
      <HonuaProvider client={client} cache={cache}>
        <Panel />
      </HonuaProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("1"));
    expect(ctrl.queryCount()).toBe(1);
  });

  it("exposes dataUpdatedAt once a fetch resolves", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    let updatedAt: number | undefined;

    function Panel() {
      const snapshot = useQuery(ctrl.source, { where: "1=1" });
      updatedAt = snapshot.dataUpdatedAt;
      return <span data-testid="panel">{snapshot.status}</span>;
    }

    render(
      <HonuaProvider client={client}>
        <Panel />
      </HonuaProvider>,
    );
    expect(updatedAt).toBeUndefined();
    await act(async () => ctrl.resolveLatest(makeResult([{ id: 1 }])));
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("success"));
    expect(typeof updatedAt).toBe("number");
  });
});

describe("useQuery suspense & error boundaries", () => {
  it("suspends during the first load, then renders data", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();

    function Panel() {
      const { data } = useQuery(ctrl.source, { where: "1=1" }, { suspense: true });
      return <span data-testid="panel">{String(data?.features.length)}</span>;
    }

    render(
      <HonuaProvider client={client}>
        <Suspense fallback={<span data-testid="fallback">loading</span>}>
          <Panel />
        </Suspense>
      </HonuaProvider>,
    );
    expect(screen.getByTestId("fallback").textContent).toBe("loading");
    expect(ctrl.queryCount()).toBe(1); // render-phase kick is idempotent

    await act(async () => ctrl.resolveLatest(makeResult([{ id: 1 }, { id: 2 }])));
    await waitFor(() => expect(screen.getByTestId("panel").textContent).toBe("2"));
  });

  it("throws typed capability errors to the nearest error boundary in suspense mode", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();

    function Panel() {
      useQuery(ctrl.source, { where: "1=1" }, { suspense: true });
      return <span data-testid="panel">rendered</span>;
    }

    render(
      <HonuaProvider client={client}>
        <Boundary>
          <Suspense fallback={<span data-testid="fallback">loading</span>}>
            <Panel />
          </Suspense>
        </Boundary>
      </HonuaProvider>,
    );

    await act(async () =>
      ctrl.rejectLatest(new HonuaCapabilityNotSupportedError("statistics", "geoservices-feature-service", "src")),
    );
    await waitFor(() =>
      expect(screen.getByTestId("boundary").textContent).toBe("HonuaCapabilityNotSupportedError"),
    );
  });

  it("throwOnError surfaces failures without suspense", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();

    function Panel() {
      const { status } = useQuery(ctrl.source, { where: "1=1" }, { throwOnError: true });
      return <span data-testid="panel">{status}</span>;
    }

    render(
      <HonuaProvider client={client}>
        <Boundary>
          <Panel />
        </Boundary>
      </HonuaProvider>,
    );

    await act(async () => ctrl.rejectLatest(new Error("boom")));
    await waitFor(() => expect(screen.getByTestId("boundary").textContent).toBe("Error"));
  });
});
