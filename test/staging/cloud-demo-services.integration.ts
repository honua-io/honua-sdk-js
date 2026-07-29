import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface CloudDemoManifest {
  readonly defaultBaseUrl: string;
  readonly globalEnv: Record<string, string>;
  readonly profiles: readonly {
    readonly id: string;
    readonly mode: string;
    readonly smoke: {
      readonly requiresEnv: readonly string[];
    };
    readonly writeSafeguards?: {
      readonly allowWritesEnv: string;
      readonly requiredAllowWritesValue: string;
      readonly writeTokenEnv: string;
      readonly resetTokenEnv: string;
      readonly resetUrlEnv: string;
    };
  }[];
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "examples", "cloud-demo-services.json"), "utf8"),
) as CloudDemoManifest;

const baseUrl = readEnv(manifest.globalEnv.baseUrl);
const manifestUrl = readEnv("HONUA_CLOUD_DEMO_MANIFEST_URL");
const cloudIt = baseUrl ? it : it.skip;
const manifestIt = manifestUrl ? it : it.skip;

function readEnv(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function authHeaders(): Headers {
  const headers = new Headers({ accept: "application/json" });
  const apiKey = readEnv(manifest.globalEnv.apiKey);
  const bearerToken = readEnv(manifest.globalEnv.bearerToken);
  if (apiKey) headers.set("x-api-key", apiKey);
  if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);
  return headers;
}

function writeSummary(summary: Record<string, unknown>): void {
  const summaryFile = readEnv(manifest.globalEnv.summaryFile);
  if (!summaryFile) return;
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
}

describe("cloud demo services staging smoke", () => {
  manifestIt("matches the vendored manifest to the published demo-services.v1.json", async () => {
    expect(new URL(manifestUrl as string).protocol).toBe("https:");
    const published = await fetch(manifestUrl as string);
    const publishedBytes = Buffer.from(await published.arrayBuffer());
    expect(
      published.ok,
      `GET ${manifestUrl} returned ${published.status}: ${publishedBytes.toString("utf8").slice(0, 200)}`,
    ).toBe(true);

    const vendoredBytes = fs.readFileSync(path.join(process.cwd(), "examples", "cloud-demo-services.json"));
    expect(publishedBytes).toEqual(vendoredBytes);
  });

  it("validates writable smoke guards before any live edit path can run", () => {
    const writable = manifest.profiles.find((profile) => profile.mode === "writable-guarded");
    expect(writable?.writeSafeguards).toBeDefined();

    const safeguards = writable?.writeSafeguards;
    if (!safeguards) return;

    const writesEnabled = readEnv(safeguards.allowWritesEnv) === safeguards.requiredAllowWritesValue;
    if (!writesEnabled) {
      expect(readEnv(safeguards.allowWritesEnv) ?? "false").not.toBe(safeguards.requiredAllowWritesValue);
      return;
    }

    expect(readEnv(safeguards.writeTokenEnv), `${safeguards.writeTokenEnv} is required`).toBeDefined();
    expect(readEnv(safeguards.resetTokenEnv), `${safeguards.resetTokenEnv} is required`).toBeDefined();
    expect(readEnv(safeguards.resetUrlEnv), `${safeguards.resetUrlEnv} is required`).toBeDefined();
  });

  cloudIt("reaches Honua Cloud compatibility before scheduled sample smoke", async () => {
    const configuredBaseUrl = baseUrl;
    expect(configuredBaseUrl).toBeDefined();
    if (!configuredBaseUrl) return;
    expect(() => new URL(configuredBaseUrl)).not.toThrow();

    const compatibilityUrl = new URL("/api/v1/admin/capabilities", configuredBaseUrl);
    const startedAt = Date.now();
    const response = await fetch(compatibilityUrl, {
      headers: authHeaders(),
    });
    const durationMs = Date.now() - startedAt;
    const rawBody = await response.text();
    let body: {
      success?: boolean;
      data?: {
        compatibility?: {
          serverVersion?: string;
          releaseChannel?: string;
        };
      };
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch (error) {
      throw new Error(
        `GET ${compatibilityUrl.toString()} returned non-JSON ${response.status}: ${rawBody.slice(0, 200)}`,
        { cause: error },
      );
    }

    expect(
      response.ok,
      `GET ${compatibilityUrl.toString()} returned ${response.status}: ${rawBody.slice(0, 200)}`,
    ).toBe(true);
    expect(body.success).toBe(true);
    expect(body.data?.compatibility?.serverVersion).toBeDefined();

    writeSummary({
      baseUrl: configuredBaseUrl,
      compatibilityUrl: compatibilityUrl.toString(),
      status: response.status,
      durationMs,
      serverVersion: body.data?.compatibility?.serverVersion,
      releaseChannel: body.data?.compatibility?.releaseChannel,
      profiles: manifest.profiles.map((profile) => ({
        id: profile.id,
        missingRequiredEnv: profile.smoke.requiresEnv.filter((envName) => !readEnv(envName)),
      })),
    });
  });
});
