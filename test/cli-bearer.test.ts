import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configPath, resolveAdminConnection, resolveConnection, writeConfig } from "../src/cli/config.js";
import { run } from "../src/cli/main.js";

const bearer = "caller-operator-token";
const rootKey = "saved-root-key";
const scopedKey = "saved-scoped-key";
let directory: string;
let output: string[];

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "honua-cli-bearer-"));
  vi.stubEnv("HONUA_CONFIG_HOME", directory);
  vi.stubEnv("HONUA_BASE_URL", "http://127.0.0.1:8080");
  vi.stubEnv("HONUA_API_KEY", undefined);
  vi.stubEnv("HONUA_ADMIN_KEY", rootKey);
  vi.stubEnv("HONUA_BEARER_TOKEN", bearer);
  await writeConfig({
    baseUrl: "http://127.0.0.1:8080",
    apiKey: scopedKey,
    profiles: { release: { baseUrl: "http://127.0.0.1:8080", apiKey: scopedKey, adminKey: rootKey } },
  });
  output = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("CLI caller bearer identity", () => {
  it.each(["Authorization", "aUtHoRiZaTiOn", "X-API-Key", "x-api-key", "Cookie"])(
    "rejects a %s request credential before sending an Admin request",
    async (header) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(await run(["admin", "api", "getConnections", "--header", `${header}=other-private-credential`])).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(output.join("")).toContain("Credential headers cannot be combined with a selected bearer token.");
      expect(output.join("")).not.toContain("other-private-credential");
      expect(output.join("")).not.toContain(bearer);
    },
  );

  it("preserves the selected bearer alongside ordinary Admin request headers", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return Response.json({ connections: [] });
    });
    expect(await run(["admin", "api", "getConnections", "--header", "X-Correlation-ID=caller-request"])).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("Authorization")).toBe(`Bearer ${bearer}`);
    expect(requests[0]?.get("X-Correlation-ID")).toBe("caller-request");
    expect(requests[0]?.get("X-API-Key")).toBeNull();
  });

  it.each([
    ["map", "export", "venues", "--bbox", "0,0,1,1"],
    ["tiles", "venues", "1/0/0"],
  ])("preserves caller identity for %s downloads and strips it on foreign redirects", async (...args) => {
    const requests: { url: URL; headers: Headers }[] = [];
    const bytes = [0x89, 0x50, 0x4e, 0x47];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.pathname.endsWith("/export")) {
        return Response.json({ href: "/temp/map.png", width: 800, height: 600 });
      }
      if (url.origin === "http://127.0.0.1:8080") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.test/map.png" } });
      }
      return new Response(new Uint8Array(bytes));
    });
    const destination = path.join(directory, "map.png");
    expect(await run([...args, "--output", destination])).toBe(0);
    expect([...readFileSync(destination)]).toEqual(bytes);
    const local = requests.filter(({ url }) => url.origin === "http://127.0.0.1:8080");
    expect(local.length).toBeGreaterThan(0);
    for (const { headers } of local) {
      expect(headers.get("Authorization")).toBe(`Bearer ${bearer}`);
      expect(headers.get("X-API-Key")).toBeNull();
    }
    const foreign = requests.filter(({ url }) => url.origin === "https://cdn.test");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.headers.get("Authorization")).toBeNull();
    expect(foreign[0]?.headers.get("X-API-Key")).toBeNull();
  });

  it.each(["synthetic\nprivate-token", "synthetic\rprivate-token", "synthetic\u0100private-token", "   "])(
    "refuses malformed bearer credentials without leaking or falling back",
    async (malformed) => {
      vi.stubEnv("HONUA_BEARER_TOKEN", malformed);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const before = readFileSync(configPath(), "utf8");
      expect(await run(["admin", "api", "getConnections", "--json"])).toBe(1);
      expect(output.join("")).toContain("Bearer token must be a single printable ASCII value.");
      if (malformed.trim()) expect(output.join("")).not.toContain("private-token");
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    },
  );

  it.each([
    ["shared command", ["connection", "test", "00000000-0000-4000-8000-000000000001", "--yes", "--json"], 2],
    ["generated Admin command", ["admin", "api", "getConnections", "--json"], 1],
  ])("keeps a rejected bearer on the %s path without retrying saved privileged keys", async (_name, args, exitCode) => {
    const before = readFileSync(configPath(), "utf8");
    const requests: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ message: "Denied for this caller" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    expect(await run([...args, "--profile", "release"])).toBe(exitCode);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("Authorization")).toBe(`Bearer ${bearer}`);
    expect(requests[0]?.get("X-API-Key")).toBeNull();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    for (const credential of [bearer, rootKey, scopedKey]) expect(output.join("")).not.toContain(credential);
  });

  it("reports the bearer scheme without printing or persisting the token", async () => {
    expect(await run(["whoami"])).toBe(0);
    expect(output.join("")).toContain("bearer");
    expect(output.join("")).not.toContain(bearer);
    expect(readFileSync(configPath(), "utf8")).not.toContain(bearer);
  });

  it("gives an explicitly selected credential precedence over environment credentials", () => {
    expect(resolveConnection({ apiKey: "explicit-key" })).toMatchObject({ apiKey: "explicit-key" });
    expect(resolveConnection({ apiKey: "explicit-key" }).bearerToken).toBeUndefined();
    vi.stubEnv("HONUA_API_KEY", "environment-key");
    expect(resolveConnection({ bearerToken: "explicit-token" })).toMatchObject({ bearerToken: "explicit-token" });
    expect(resolveConnection({ bearerToken: "explicit-token" }).apiKey).toBeUndefined();
    expect(resolveAdminConnection({ adminKey: "explicit-admin" }).adminKey).toBe("explicit-admin");
  });

  it("refuses ambiguous credentials at the same precedence without exposing them", () => {
    vi.stubEnv("HONUA_API_KEY", "environment-key");
    expect(() => resolveConnection()).toThrow("Choose one credential");
    expect(() => resolveConnection({ apiKey: "explicit-key", bearerToken: "explicit-token" })).toThrow(
      "Choose one credential",
    );
    expect(() => resolveAdminConnection({ adminKey: "explicit-admin", bearerToken: "explicit-token" })).toThrow(
      "Choose one credential",
    );
  });

  it("passes an embedded CLI caller token through the shared runtime", async () => {
    vi.stubEnv("HONUA_BEARER_TOKEN", undefined);
    vi.stubEnv("HONUA_API_KEY", "environment-key");
    const requests: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }),
    );
    expect(await run(["connection", "test", "connection-a", "--yes", "--json"], { bearerToken: bearer })).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("Authorization")).toBe(`Bearer ${bearer}`);
    expect(requests[0]?.get("X-API-Key")).toBeNull();
  });
});
