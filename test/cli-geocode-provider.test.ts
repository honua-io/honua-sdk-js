import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";

function captureStreams(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

const NOMINATIM_BODY = [
  {
    place_id: 282983083,
    osm_type: "relation",
    osm_id: 119231215,
    lat: "21.3069444",
    lon: "-157.8583333",
    category: "place",
    type: "city",
    importance: 0.676,
    display_name: "Honolulu, Honolulu County, Hawaii, United States",
  },
];

describe("honua geocode --provider", () => {
  let cap: ReturnType<typeof captureStreams>;
  beforeEach(() => {
    cap = captureStreams();
  });
  afterEach(() => {
    cap.restore();
    vi.unstubAllGlobals();
  });

  it("geocodes through the nominatim adapter with a policy-compliant User-Agent", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(NOMINATIM_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    const code = await run([
      "geocode",
      "--provider",
      "nominatim",
      "--base-url",
      "https://nominatim.example.test",
      "Honolulu",
    ]);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://nominatim.example.test");
    expect(url.pathname).toBe("/search");
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toContain("honua-cli");

    const output = cap.out.join("");
    expect(output).toContain("Honolulu, Honolulu County, Hawaii, United States");
    expect(output).toContain("Attribution: Data © OpenStreetMap contributors");
    expect(output).toContain("Usage policy: https://operations.osmfoundation.org/policies/nominatim/");
  });

  it("emits provenance-stamped JSON with --json", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify(NOMINATIM_BODY), { status: 200 })) as typeof fetch);

    const code = await run([
      "geocode",
      "--provider",
      "nominatim",
      "--base-url",
      "https://nominatim.example.test",
      "--json",
      "Honolulu",
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(""));
    expect(parsed[0].provenance.provider).toBe("nominatim");
    expect(parsed[0].provenance.attribution).toContain("OpenStreetMap contributors");
  });

  it("fails with a clear error when --base-url is missing for a third-party provider", async () => {
    const original = process.env.HONUA_BASE_URL;
    delete process.env.HONUA_BASE_URL;
    try {
      const code = await run(["geocode", "--provider", "nominatim", "Honolulu"], {});
      expect(code).toBe(1);
      expect(cap.err.join("")).toContain("requires --base-url");
    } finally {
      if (original !== undefined) process.env.HONUA_BASE_URL = original;
    }
  });

  it("rejects an unknown provider name", async () => {
    const code = await run(["geocode", "--provider", "google", "--base-url", "https://example.test", "Honolulu"]);
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain('Unknown geocoding provider "google"');
  });
});
