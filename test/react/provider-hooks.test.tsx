// @vitest-environment jsdom
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { SourceDescriptor } from "../../src/contract/index.js";
import type { HonuaClient } from "../../src/core/client.js";
import {
  HonuaProvider,
  useCapabilities,
  useDataset,
  useHonuaClient,
  useHonuaQueryCache,
} from "../../src/react/index.js";
import { fakeClient, sampleCompatibility } from "./support.js";

afterEach(cleanup);

function wrapper(client: HonuaClient) {
  return ({ children }: { children: ReactNode }) => <HonuaProvider client={client}>{children}</HonuaProvider>;
}

const descriptors: SourceDescriptor[] = [
  {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://honua.example.com", serviceId: "incidents", layerId: 0 },
    capabilities: new Set(["query"]),
  },
];

describe("HonuaProvider / useHonuaClient", () => {
  it("throws a descriptive error when a hook is used outside a provider", () => {
    expect(() => renderHook(() => useHonuaClient())).toThrow(/must be used within a <HonuaProvider>/);
  });

  it("exposes the client and a stable query cache", () => {
    const { client } = fakeClient();
    const { result, rerender } = renderHook(
      () => ({ client: useHonuaClient(), cache: useHonuaQueryCache() }),
      { wrapper: wrapper(client) },
    );
    const firstCache = result.current.cache;
    expect(result.current.client).toBe(client);
    rerender();
    expect(result.current.cache).toBe(firstCache);
  });
});

describe("useDataset", () => {
  it("returns a referentially stable dataset across re-renders", () => {
    const { client } = fakeClient();
    const { result, rerender } = renderHook(() => useDataset({ id: "ops", sources: descriptors }), {
      wrapper: wrapper(client),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.id).toBe("ops");
  });

  it("rebuilds the dataset when the source descriptors change", () => {
    const { client } = fakeClient();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDataset({ id, sources: descriptors }),
      { wrapper: wrapper(client), initialProps: { id: "ops" } },
    );
    const first = result.current;
    rerender({ id: "ops-2" });
    expect(result.current).not.toBe(first);
    expect(result.current.id).toBe("ops-2");
  });
});

describe("useCapabilities", () => {
  it("moves through loading → success and caches the fetch across consumers", async () => {
    const fake = fakeClient();

    function Caps() {
      const caps = useCapabilities();
      return <span data-testid="caps">{caps.isLoading ? "loading" : (caps.data?.serverVersion ?? "none")}</span>;
    }

    render(
      <HonuaProvider client={fake.client}>
        <Caps />
        <Caps />
      </HonuaProvider>,
    );

    expect(screen.getAllByTestId("caps")[0].textContent).toBe("loading");
    fake.resolveCompat(sampleCompatibility);
    await waitFor(() => expect(screen.getAllByTestId("caps")[0].textContent).toBe("1.2.3"));
    // Both consumers share one cache key → exactly one server call.
    expect(fake.compatCalls).toBe(1);
    expect(screen.getAllByTestId("caps")[1].textContent).toBe("1.2.3");
  });

  it("does not fetch when disabled", () => {
    const fake = fakeClient();
    renderHook(() => useCapabilities({ enabled: false }), { wrapper: wrapper(fake.client) });
    expect(fake.compatCalls).toBe(0);
  });
});

describe("provider cache isolation", () => {
  it("keeps two providers' caches independent", async () => {
    const a = fakeClient();
    const b = fakeClient();

    function Caps({ label }: { label: string }) {
      const caps = useCapabilities();
      return <span data-testid={label}>{caps.data?.serverVersion ?? "loading"}</span>;
    }

    render(
      <>
        <HonuaProvider client={a.client}>
          <Caps label="a" />
        </HonuaProvider>
        <HonuaProvider client={b.client}>
          <Caps label="b" />
        </HonuaProvider>
      </>,
    );

    a.resolveCompat({ ...sampleCompatibility, serverVersion: "9.9.9" });
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("9.9.9"));
    expect(screen.getByTestId("b").textContent).toBe("loading");
    expect(a.compatCalls).toBe(1);
    expect(b.compatCalls).toBe(1);
  });
});
