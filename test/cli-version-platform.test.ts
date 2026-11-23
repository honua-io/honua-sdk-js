import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { platformVersionOf } from "../src/cli/commands/version.js";
import { writeConfig } from "../src/cli/config.js";
import { CLI_VERSION, run } from "../src/cli/main.js";

const server = "http://127.0.0.1:8080";
let directory: string;
let stdout: string[];
let requests: { url: string; headers: Headers }[];

function capabilities(serverVersion: string) {
  return {
    success: true,
    data: {
      serverVersion,
      compatibility: {
        serverVersion,
        releaseChannel: "stable",
        controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
        metadataSchemas: [],
        features: {
          metadataResources: true,
          manifestExport: true,
          manifestApply: true,
          manifestDryRun: true,
          manifestPrune: true,
        },
      },
    },
  };
}

function serve(respond: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
    return respond();
  });
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "honua-cli-version-"));
  vi.stubEnv("HONUA_CONFIG_HOME", directory);
  vi.stubEnv("HONUA_BASE_URL", undefined);
  vi.stubEnv("HONUA_API_KEY", undefined);
  vi.stubEnv("HONUA_BEARER_TOKEN", undefined);
  stdout = [];
  requests = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("honua --version without a server", () => {
  it("strips the server build revision from the platform version", () => {
    expect(platformVersionOf("2026.1.0+5f4adbb")).toBe("2026.1.0");
    expect(platformVersionOf("2026.1.0-rc.2")).toBe("2026.1.0-rc.2");
    expect(platformVersionOf("+5f4adbb")).toBe("");
  });

  it("reports only the CLI version and contacts nothing when no server is configured", async () => {
    serve(() => Response.json(capabilities("2026.1.0")));
    expect(await run(["--version"])).toBe(0);
    expect(requests).toHaveLength(0);
    expect(stdout.join("")).toBe(
      `honua CLI ${CLI_VERSION}\nHonua platform: not connected (pass --base-url or --profile, set HONUA_BASE_URL, or run honua login)\n`,
    );
  });
});

describe("honua --version against a configured server", () => {
  it("prints both versions when connected, without sending a credential", async () => {
    vi.stubEnv("HONUA_BASE_URL", server);
    vi.stubEnv("HONUA_API_KEY", "caller-private-key");
    serve(() => Response.json(capabilities("2026.1.0+5f4adbb")));
    expect(await run(["-V"])).toBe(0);
    expect(stdout.join("")).toBe(`honua CLI ${CLI_VERSION}\nHonua platform 2026.1.0 (${server})\n`);
    expect(requests.map((request) => request.url)).toEqual([`${server}/api/v1/admin/capabilities`]);
    expect(requests[0]?.headers.get("X-API-Key")).toBeNull();
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
  });

  it("emits platformVersion in JSON for the release surface comparison", async () => {
    serve(() => Response.json(capabilities("2026.1.0-rc.2+5f4adbb")));
    expect(await run(["version", "--base-url", `${server}/`, "--json"])).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      name: "@honua/sdk-js",
      version: CLI_VERSION,
      server,
      platformVersion: "2026.1.0-rc.2",
    });
  });

  it("uses a saved profile's server", async () => {
    await writeConfig({ profiles: { prod: { baseUrl: "https://honua.example" } } });
    serve(() => Response.json(capabilities("2026.1.0")));
    expect(await run(["--version", "--profile", "prod", "--json"])).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ server: "https://honua.example", platformVersion: "2026.1.0" });
  });
});

describe("honua --version when the platform cannot be read", () => {
  it("still succeeds with the CLI version when the server cannot be read", async () => {
    vi.stubEnv("HONUA_BASE_URL", server);
    serve(() => new Response("unavailable", { status: 503 }));
    expect(await run(["--version", "--json"])).toBe(0);
    const report = JSON.parse(stdout.join(""));
    expect(report).toMatchObject({ version: CLI_VERSION, server, platformVersion: null });
    expect(report.platformError).toEqual(expect.any(String));
    expect(requests).toHaveLength(1);
  });

  it("names the server and the reason in text output when the probe fails", async () => {
    vi.stubEnv("HONUA_BASE_URL", server);
    serve(() => Response.json({ success: true, data: {} }));
    expect(await run(["--version"])).toBe(0);
    expect(stdout.join("")).toContain(`honua CLI ${CLI_VERSION}\nHonua platform unknown (${server}): `);
  });

  it("reports an unknown profile without contacting a server", async () => {
    serve(() => Response.json(capabilities("2026.1.0")));
    expect(await run(["--version", "--profile", "missing", "--json"])).toBe(0);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      server: null,
      platformVersion: null,
      platformError: expect.stringContaining('Honua profile "missing" was not found'),
    });
  });
});

describe("honua --version transport and credential edge cases", () => {
  it("reports a network failure instead of failing the version command", async () => {
    vi.stubEnv("HONUA_BASE_URL", server);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await run(["--version", "--json"])).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      version: CLI_VERSION,
      server,
      platformVersion: null,
      platformError: expect.stringContaining("fetch failed"),
    });
  });

  it("probes even when the environment holds two conflicting credentials", async () => {
    vi.stubEnv("HONUA_BASE_URL", server);
    vi.stubEnv("HONUA_API_KEY", "caller-private-key");
    vi.stubEnv("HONUA_BEARER_TOKEN", "caller-private-token");
    serve(() => Response.json(capabilities("2026.1.0")));
    expect(await run(["--version", "--json"])).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ platformVersion: "2026.1.0" });
    expect(stdout.join("")).not.toContain("caller-private");
  });
});
