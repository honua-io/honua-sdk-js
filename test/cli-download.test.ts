import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapCommand } from "../src/cli/commands/map.js";
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

  it("follows a redirect off the base origin without replaying the key", async () => {
    const calls = stubFetch((url) => {
      if (new URL(url).origin === "https://maps.test") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.test/export.png" } });
      }
      return new Response(new Uint8Array([4, 2]), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([4, 2]);
    expect(calls.map((call) => call.url)).toEqual(["https://maps.test/export/img.png", "https://cdn.test/export.png"]);
    expect(calls.map((call) => call.apiKey)).toEqual(["secret", undefined]);
  });

  it("allows an uncredentialed cross-origin href to redirect between CDN origins", async () => {
    const calls = stubFetch((url) => {
      if (url === "https://cdn-a.test/signed-export") {
        return new Response(null, { status: 307, headers: { location: "https://cdn-b.test/regional-export" } });
      }
      return new Response(new Uint8Array([8]), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("https://cdn-a.test/signed-export", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([8]);
    expect(calls.map((call) => call.apiKey)).toEqual([undefined, undefined]);
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

  it("retries an opaque redirect with automatic redirects and no API key", async () => {
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? ({ type: "opaqueredirect", status: 0 } as unknown as Response)
        : new Response(new Uint8Array([6]), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([6]);
    expect(calls.map((call) => call.apiKey)).toEqual(["secret", undefined]);
    expect(calls.map((call) => call.redirect)).toEqual(["manual", "follow"]);
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

  it("uses the env-resolved base URL for an authenticated map export download", async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-cli-download-"));
    const outputPath = path.join(outputDirectory, "map.png");
    const priorBaseUrl = process.env.HONUA_BASE_URL;
    process.env.HONUA_BASE_URL = "https://maps.test";
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, apiKey: headers.get("x-api-key") ?? undefined, redirect: init?.redirect });
      if (url === "https://maps.test/export/result.png") {
        return new Response(new Uint8Array([3, 1, 4]), { status: 200 });
      }
      return new Response(JSON.stringify({ href: "https://maps.test/export/result.png", width: 800, height: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await mapCommand(
        {
          positionals: ["export", "planning"],
          flags: { bbox: "-156.7,20.7,-156.3,21.0", output: outputPath },
        },
        { apiKey: "secret" },
      );

      expect([...fs.readFileSync(outputPath)]).toEqual([3, 1, 4]);
      const download = calls.find((call) => call.url === "https://maps.test/export/result.png");
      expect(download).toMatchObject({ apiKey: "secret", redirect: "manual" });
    } finally {
      if (priorBaseUrl === undefined) delete process.env.HONUA_BASE_URL;
      else process.env.HONUA_BASE_URL = priorBaseUrl;
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("resolves a root-relative export href against the configured origin and returns the image bytes", async () => {
    const image = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const calls = stubFetch(() => new Response(new Uint8Array(image), { status: 200 }));

    const bytes = await downloadCredentialedResource("/temp/915e636f6cf8471e81f443ab63f5b8c8.png", {
      baseUrl: "http://localhost:8080",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual(image);
    expect(calls.map((call) => call.url)).toEqual(["http://localhost:8080/temp/915e636f6cf8471e81f443ab63f5b8c8.png"]);
    expect(calls[0]).toMatchObject({ apiKey: "secret", redirect: "manual" });
  });

  it("resolves a root-relative href at the server root when the base URL has a path prefix", async () => {
    const image = [0x89, 0x50, 0x4e, 0x47];
    const calls = stubFetch(() => new Response(new Uint8Array(image), { status: 200 }));

    const bytes = await downloadCredentialedResource("/temp/866a75df175f412ea817127e62fdf6c2.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual(image);
    // `/temp/…` is served at the origin, not under the configured path prefix.
    expect(calls.map((call) => call.url)).toEqual(["https://maps.test/temp/866a75df175f412ea817127e62fdf6c2.png"]);
    expect(calls[0]).toMatchObject({ apiKey: "secret", redirect: "manual" });
  });

  it("keeps a configured path prefix for a path-relative href", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([2, 2]), { status: 200 }));

    const bytes = await downloadCredentialedResource("exports/file.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([2, 2]);
    expect(calls.map((call) => call.url)).toEqual(["https://maps.test/arcgis/exports/file.png"]);
    expect(calls[0]?.apiKey).toBe("secret");
  });

  it("leaves an absolute same-origin href unchanged when the base URL has a path prefix", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url)).toEqual(["https://maps.test/export/img.png"]);
    expect(calls[0]).toMatchObject({ apiKey: "secret", redirect: "manual" });
  });

  it("leaves an absolute cross-origin href unchanged and does not send the key", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([9, 9]), { status: 200 }));

    const bytes = await downloadCredentialedResource("https://attacker.test/steal.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([9, 9]);
    expect(calls.map((call) => call.url)).toEqual(["https://attacker.test/steal.png"]);
    expect(calls[0]?.apiKey).toBeUndefined();
    expect(calls[0]?.redirect).toBe("manual");
  });

  it("resolves a protocol-relative or backslash href off-origin and does not send the key", async () => {
    const image = [4, 4, 4];
    const calls = stubFetch(() => new Response(new Uint8Array(image), { status: 200 }));

    const protocolRelative = await downloadCredentialedResource("//cdn.test/export.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });
    const backslash = await downloadCredentialedResource("/\\cdn.test/export.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...protocolRelative]).toEqual(image);
    expect([...backslash]).toEqual(image);
    expect(calls.map((call) => call.url)).toEqual(["https://cdn.test/export.png", "https://cdn.test/export.png"]);
    expect(calls.map((call) => call.apiKey)).toEqual([undefined, undefined]);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  it("follows a relative redirect and then a cross-origin redirect without leaking the key", async () => {
    const image = [0x89, 0x50, 0x4e, 0x47, 0x01];
    const calls = stubFetch((url) => {
      if (url === "https://maps.test/temp/a.png") {
        return new Response(null, { status: 302, headers: { location: "moved.png" } });
      }
      if (url === "https://maps.test/temp/moved.png") {
        return new Response(null, { status: 302, headers: { location: "//cdn.test/final.png" } });
      }
      return new Response(new Uint8Array(image), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("/temp/a.png", {
      baseUrl: "https://maps.test/arcgis",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual(image);
    expect(calls.map((call) => call.url)).toEqual([
      "https://maps.test/temp/a.png",
      "https://maps.test/temp/moved.png",
      "https://cdn.test/final.png",
    ]);
    expect(calls.map((call) => call.apiKey)).toEqual(["secret", "secret", undefined]);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  it("follows a same-origin relative Location and a later cross-origin relative Location without the key", async () => {
    const calls = stubFetch((url) => {
      if (url === "https://maps.test/export/img.png") {
        return new Response(null, { status: 307, headers: { location: "/export/moved.png" } });
      }
      if (url === "https://maps.test/export/moved.png") {
        return new Response(null, { status: 302, headers: { location: "/\\cdn.test/regional.png" } });
      }
      return new Response(new Uint8Array([8, 1]), { status: 200 });
    });

    const bytes = await downloadCredentialedResource("https://maps.test/export/img.png", {
      baseUrl: "https://maps.test",
      apiKey: "secret",
    });

    expect([...bytes]).toEqual([8, 1]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://maps.test/export/img.png",
      "https://maps.test/export/moved.png",
      "https://cdn.test/regional.png",
    ]);
    expect(calls.map((call) => call.apiKey)).toEqual(["secret", "secret", undefined]);
  });

  it("does not fetch a relative href when no base URL is configured", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([1]), { status: 200 }));

    await expect(downloadCredentialedResource("/temp/file.png", { apiKey: "secret" })).rejects.toThrow(/base URL/);
    expect(calls).toHaveLength(0);
  });

  it("still stops at the redirect cap when each Location is relative", async () => {
    const calls = stubFetch(() => new Response(null, { status: 302, headers: { location: "next" } }));

    await expect(
      downloadCredentialedResource("/export/img.png", {
        baseUrl: "https://maps.test",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/maximum of 20 redirects/);

    // The cap allows 20 followed redirects, so the 21st response is the one refused.
    // `next` replaces the last path segment, then stays on that URL.
    expect(calls).toHaveLength(21);
    expect(calls[0]?.url).toBe("https://maps.test/export/img.png");
    expect(calls[1]?.url).toBe("https://maps.test/export/next");
    expect(calls[20]?.url).toBe("https://maps.test/export/next");
    expect(calls.every((call) => call.apiKey === "secret" && call.redirect === "manual")).toBe(true);
  });

  it("downloads a root-relative map export href through the CLI using the configured base URL", async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-cli-download-"));
    const outputPath = path.join(outputDirectory, "maui.png");
    const priorBaseUrl = process.env.HONUA_BASE_URL;
    process.env.HONUA_BASE_URL = "https://maps.test/arcgis";
    const image = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const href = "/temp/866a75df175f412ea817127e62fdf6c2.png";
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, apiKey: headers.get("x-api-key") ?? undefined, redirect: init?.redirect });
      if (url === "https://maps.test/temp/866a75df175f412ea817127e62fdf6c2.png") {
        return new Response(new Uint8Array(image), { status: 200 });
      }
      return new Response(JSON.stringify({ href, width: 800, height: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await mapCommand(
        {
          positionals: ["export", "maui-parcels"],
          flags: { bbox: "-156.7,20.7,-156.3,21.0", size: "800x600", output: outputPath },
        },
        { apiKey: "secret" },
      );

      expect([...fs.readFileSync(outputPath)]).toEqual(image);
      expect(calls.some((call) => call.url === href)).toBe(false);
      expect(
        calls.some((call) => call.url === "https://maps.test/arcgis/temp/866a75df175f412ea817127e62fdf6c2.png"),
      ).toBe(false);
      const download = calls.find((call) => call.url === "https://maps.test/temp/866a75df175f412ea817127e62fdf6c2.png");
      expect(download).toMatchObject({ apiKey: "secret", redirect: "manual" });
      const crossOrigin = calls.filter((call) => {
        try {
          return new URL(call.url).origin !== "https://maps.test";
        } catch {
          return true;
        }
      });
      expect(crossOrigin.every((call) => call.apiKey === undefined)).toBe(true);
    } finally {
      if (priorBaseUrl === undefined) delete process.env.HONUA_BASE_URL;
      else process.env.HONUA_BASE_URL = priorBaseUrl;
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
