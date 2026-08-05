// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { Query, Source } from "../../src/contract/index.js";
import type { HonuaClient } from "../../src/core/client.js";
import { HonuaProvider, useQuery } from "../../src/react/index.js";
import { controllableSource, fakeClient, makeResult } from "./support.js";

afterEach(cleanup);

function wrapper(client: HonuaClient) {
  return ({ children }: { children: ReactNode }) => <HonuaProvider client={client}>{children}</HonuaProvider>;
}

function useQueryWith(source: Source, query?: Query) {
  return useQuery(source, query);
}

describe("useQuery lifecycle", () => {
  it("transitions idle → loading → success and exposes data", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { result } = renderHook(() => useQueryWith(ctrl.source, { where: "1=1" }), {
      wrapper: wrapper(client),
    });

    expect(result.current.status).toBe("loading");
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }, { id: 2 }]));
    });

    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.data?.features).toHaveLength(2);
    expect(result.current.isLoading).toBe(false);
    expect(ctrl.queryCount()).toBe(1);
  });

  it("keeps the resolved result referentially stable across re-renders", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { result, rerender } = renderHook(() => useQueryWith(ctrl.source, { where: "1=1" }), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }]));
    });
    await waitFor(() => expect(result.current.status).toBe("success"));

    const firstData = result.current.data;
    rerender();
    expect(result.current.data).toBe(firstData);
  });

  it("surfaces query rejections as an error state", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { result } = renderHook(() => useQueryWith(ctrl.source, { where: "bad" }), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      ctrl.rejectLatest(new Error("boom"));
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect((result.current.error as Error).message).toBe("boom");
  });

  it("does not run when the source is null", () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useQuery(null, { where: "1=1" }), { wrapper: wrapper(client) });
    expect(result.current.status).toBe("idle");
  });

  it("refetch supersedes and re-runs the query", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { result } = renderHook(() => useQueryWith(ctrl.source, { where: "1=1" }), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }]));
    });
    await waitFor(() => expect(result.current.status).toBe("success"));

    act(() => {
      result.current.refetch();
    });
    expect(result.current.isFetching).toBe(true);
    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }, { id: 2 }]));
    });
    await waitFor(() => expect(result.current.data?.features).toHaveLength(2));
    expect(ctrl.queryCount()).toBe(2);
  });

  it("shares a single fetch between two consumers of the same (source, query)", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();

    function Row({ testid }: { testid: string }) {
      const { data, status } = useQueryWith(ctrl.source, { where: "1=1" });
      return <span data-testid={testid}>{status === "success" ? String(data?.features.length) : status}</span>;
    }

    render(
      <HonuaProvider client={client}>
        <Row testid="a" />
        <Row testid="b" />
      </HonuaProvider>,
    );

    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 1 }]));
    });
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("1"));
    expect(screen.getByTestId("b").textContent).toBe("1");
    expect(ctrl.queryCount()).toBe(1);
  });
});

describe("useQuery abort + race", () => {
  it("aborts the in-flight request when the last consumer unmounts", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { unmount } = renderHook(() => useQueryWith(ctrl.source, { where: "1=1" }), {
      wrapper: wrapper(client),
    });

    expect(ctrl.queryCount()).toBe(1);
    const call = ctrl.calls[0];
    expect(call.aborted()).toBe(false);
    unmount();
    expect(call.aborted()).toBe(true);
  });

  it("aborts the previous request when the query key changes and keeps the latest result", async () => {
    const { client } = fakeClient();
    const ctrl = controllableSource();
    const { result, rerender } = renderHook(({ where }: { where: string }) => useQueryWith(ctrl.source, { where }), {
      wrapper: wrapper(client),
      initialProps: { where: "a=1" },
    });

    const firstCall = ctrl.calls[0];
    rerender({ where: "a=2" });
    // The stale request is aborted (its abort listener rejects it); the cache
    // ignores that superseded rejection and only honors the latest call.
    expect(firstCall.aborted()).toBe(true);
    expect(ctrl.queryCount()).toBe(2);

    await act(async () => {
      ctrl.resolveLatest(makeResult([{ id: 99 }]));
    });
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.data?.features?.[0]?.attributes).toEqual({ id: 99 });
  });
});
