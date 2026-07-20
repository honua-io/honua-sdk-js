import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCredentialedResource } from "../src/cli/download.js";

interface FetchCall {
  url: string;
  apiKey: string | undefined;
  redirect: RequestRedirect | undefined;
}

/**
 * Install a fake global `fetch` that records every call and answers from
 * `responder`. Returns the recorded call list.
 */
function stubFetch(responder: (url: string) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, apiKey: headers.get("x-api-key") ?? undefined, redirect: init?.redirect });
    return responder(url);
  });
  return calls;
}

describe("downloadCredentialedResource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the API key and returns the bytes for a same-origin download", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.apiKey).toBe("secret");
    // Downloads must never let the runtime silently auto-follow redirects.
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("never sends the API key when the href is already cross-origin", async () => {
    // A compromised server can return an `export` href that points straight at
    // another origin; the key must not ride along even on the very first hop.
    const calls = stubFetch(() => new Response(new Uint8Array([9]), { status: 200 }));

    const bytes = await downloadCredentialedResource("https://attacker.test/steal", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([9]);
    expect(calls[0]?.apiKey).toBeUndefined();
  });

  it("refuses to follow a redirect that leaves the base origin and never replays the key", async () => {
    const calls = stubFetch((url) => {
      if (new URL(url).origin === "https://maps.test") {
        return new Response(null, { status: 302, headers: { location: "https://attacker.test/steal" } });
      }
      return new Response(new Uint8Array([0]), { status: 200 });
    });

    await expect(
      downloadCredentialedResource("https://maps.test/export/img.png", {
        baseUrl: "https://maps.test",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/cross-origin/i);

    // Only the first, same-origin request was ever issued — the attacker host
    // was never contacted, so the key could not have leaked.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => new URL(c.url).origin === "https://maps.test")).toBe(true);
  });

  it("follows a same-origin redirect and keeps carrying the key on-origin", async () => {
    const calls = stubFetch((url) => {
      if (url === "https://maps.test/export/img.png") {
        return new Response(null, { status: 302, headers: { location: "https://maps.test/export/moved.png" } });
      }
      return new Response(new Uint8Array([7, 7]), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([7, 7]);
    expect(calls.map((c) => c.url)).toEqual(["https://maps.test/export/img.png", "https://maps.test/export/moved.png"]);
    expect(calls.every((c) => c.apiKey === "secret")).toBe(true);
  });

  it("rejects an opaque cross-origin redirect rather than leaking the key", async () => {
    stubFetch(() => ({ type: "opaqueredirect", status: 0 }) as unknown as Response);

    await expect(
      downloadCredentialedResource("https://maps.test/export/img.png", {
        baseUrl: "https://maps.test",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/opaque/i);
  });

  it("throws on a non-ok terminal response", async () => {
    stubFetch(() => new Response(null, { status: 404, statusText: "Not Found" }));

    await expect(
      downloadCredentialedResource("https://maps.test/export/img.png", {
        baseUrl: "https://maps.test",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/404/);
  });

  it("does not attach the key when no base origin is configured (fail-closed)", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([5]), { status: 200 }));

    await downloadCredentialedResource("https://maps.test/export/img.png", { apiKey: "secret" });

    expect(calls[0]?.apiKey).toBeUndefined();
  });
});
