import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type CloudDemoMode = "readonly" | "realtime" | "writable-guarded";

interface CloudDemoManifest {
  readonly format: string;
  readonly issue: number;
  readonly ownerRepo: string;
  readonly defaultBaseUrl: string;
  readonly globalEnv: Record<string, string>;
  readonly fixtureFallback: {
    readonly state: string;
    readonly requiredSignal: string;
  };
  readonly cachePolicy: {
    readonly metadata: {
      readonly cacheable: boolean;
      readonly resources: readonly string[];
      readonly defaultTtlMs: number;
    };
    readonly uncached: readonly string[];
    readonly materialized: readonly string[];
  };
  readonly profiles: readonly CloudDemoProfile[];
}

interface CloudDemoProfile {
  readonly id: string;
  readonly title: string;
  readonly sampleDir: string;
  readonly mode: CloudDemoMode;
  readonly cloud: Record<string, unknown>;
  readonly fixtureFallback: {
    readonly state: string;
    readonly mode: string;
    readonly command: string;
  };
  readonly smoke: {
    readonly fixtureCommand: string;
    readonly cloudCommand: string;
    readonly requiresEnv: readonly string[];
  };
  readonly cacheNotes: {
    readonly metadata: string;
    readonly featureState: string;
  };
  readonly writeSafeguards?: {
    readonly allowWritesEnv: string;
    readonly requiredAllowWritesValue: string;
    readonly writeTokenEnv: string;
    readonly resetTokenEnv: string;
    readonly resetUrlEnv: string;
    readonly resetCadence: string;
    readonly requiredResetState: string;
  };
}

const requiredProfileIds = [
  "quickstart-feature-readonly",
  "service-explorer-feature-readonly",
  "storytelling-25d-readonly",
  "kepler-analytics-materialized",
  "incident-realtime-stream",
  "edit-workflow-writable-guarded",
] as const;

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function readManifest(): CloudDemoManifest {
  return JSON.parse(readText("examples/cloud-demo-services.json")) as CloudDemoManifest;
}

function collectEnvNames(value: unknown, names = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^(?:HONUA|VITE)_/.test(value)) {
      names.add(value);
    }
    return names;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnvNames(item, names);
    }
    return names;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectEnvNames(nested, names);
    }
  }

  return names;
}

function cloudHasSeededTarget(profile: CloudDemoProfile): boolean {
  const service = profile.cloud.service as Record<string, unknown> | undefined;
  const stream = profile.cloud.stream as Record<string, unknown> | undefined;
  return Boolean(service || stream);
}

describe("cloud demo services manifest", () => {
  it("keeps the issue #128 manifest contract versioned and sample-scoped", () => {
    const manifest = readManifest();

    expect(manifest).toMatchObject({
      format: "honua.cloud-demo-services.v1",
      issue: 128,
      ownerRepo: "honua-io/honua-sdk-js",
      defaultBaseUrl: "https://cloud.honua.io",
    });
    expect(manifest.fixtureFallback.state).toBe("fixture-degraded");
    expect(manifest.fixtureFallback.requiredSignal).toContain("fixture/degraded");
    expect(Object.values(manifest.globalEnv)).toEqual(
      expect.arrayContaining([
        "HONUA_CLOUD_DEMO_BASE_URL",
        "HONUA_CLOUD_DEMO_API_KEY",
        "HONUA_CLOUD_DEMO_BEARER_TOKEN",
        "HONUA_CLOUD_DEMO_METADATA_TTL_MS",
        "HONUA_CLOUD_DEMO_SUMMARY_FILE",
      ]),
    );
  });

  it("lists flagship sample profiles with fixture fallback and seeded cloud targets", () => {
    const manifest = readManifest();
    const profilesById = new Map(manifest.profiles.map((profile) => [profile.id, profile]));

    expect([...profilesById.keys()]).toEqual(requiredProfileIds);

    for (const profile of manifest.profiles) {
      expect(fs.existsSync(path.join(process.cwd(), profile.sampleDir)), `${profile.id} sample dir exists`).toBe(true);
      expect(["readonly", "realtime", "writable-guarded"]).toContain(profile.mode);
      expect(cloudHasSeededTarget(profile), `${profile.id} needs a service or stream target`).toBe(true);
      expect(profile.fixtureFallback.state, `${profile.id} needs fixture-degraded state`).toBe("fixture-degraded");
      expect(profile.fixtureFallback.command, `${profile.id} needs a fixture command`).toMatch(/^npm run /);
      expect(profile.smoke.fixtureCommand, `${profile.id} needs fixture smoke`).toMatch(/^npm run /);
      expect(profile.smoke.cloudCommand, `${profile.id} needs cloud smoke`).toMatch(/^npm run /);
      expect(
        profile.smoke.requiresEnv.some(
          (envName) =>
            envName.endsWith("_BASE_URL") || envName.endsWith("_STREAM_URL") || envName.endsWith("_ENDPOINT"),
        ),
        `${profile.id} needs a base URL, stream URL, or endpoint env requirement`,
      ).toBe(true);
      expect(profile.cacheNotes.metadata, `${profile.id} needs metadata cache note`).toBe("cacheable-metadata");
    }
  });

  it("keeps writable reset safeguards and realtime authority explicit", () => {
    const manifest = readManifest();
    const realtime = manifest.profiles.find((profile) => profile.id === "incident-realtime-stream");
    const writable = manifest.profiles.find((profile) => profile.id === "edit-workflow-writable-guarded");

    expect(realtime).toBeDefined();
    expect(realtime?.mode).toBe("realtime");
    expect((realtime?.cloud.stream as { authority?: string } | undefined)?.authority).toBe("realtime-stream");
    expect((realtime?.cloud.stream as { urlEnv?: string } | undefined)?.urlEnv).toBe("VITE_HONUA_INCIDENT_STREAM_URL");
    expect(realtime?.cacheNotes.featureState).toBe("uncached-realtime");

    expect(writable).toBeDefined();
    expect(writable?.mode).toBe("writable-guarded");
    expect(writable?.writeSafeguards).toMatchObject({
      allowWritesEnv: "HONUA_CLOUD_DEMO_ALLOW_WRITES",
      requiredAllowWritesValue: "true",
      writeTokenEnv: "HONUA_CLOUD_DEMO_WRITE_TOKEN",
      resetTokenEnv: "HONUA_CLOUD_DEMO_RESET_TOKEN",
      resetUrlEnv: "HONUA_CLOUD_DEMO_RESET_URL",
      resetCadence: "before-and-after-smoke",
      requiredResetState: "seeded-clean",
    });
    expect(writable?.cacheNotes.featureState).toBe("uncached-edits");
  });

  it("documents metadata caching separately from realtime, edits, and ad hoc spatial requests", () => {
    const manifest = readManifest();
    const uncached = manifest.cachePolicy.uncached.join(" ");

    expect(manifest.cachePolicy.metadata.cacheable).toBe(true);
    expect(manifest.cachePolicy.metadata.defaultTtlMs).toBe(900000);
    expect(manifest.cachePolicy.metadata.resources).toEqual(
      expect.arrayContaining(["service lists", "layer descriptors", "fields", "domains", "capabilities"]),
    );
    expect(uncached).toContain("realtime incident state");
    expect(uncached).toContain("edit submissions");
    expect(uncached).toContain("ad hoc spatial queries");
    expect(manifest.cachePolicy.materialized.join(" ")).toContain("kepler analytics exports");
  });

  it("keeps the env example and docs traceable to the manifest", () => {
    const manifest = readManifest();
    const envExample = readText("examples/cloud-demo.env.example");
    const docs = readText("docs/honua-cloud-demo-services.md");
    const envNames = [...collectEnvNames(manifest)].sort();

    for (const envName of envNames) {
      expect(envExample, `env example missing ${envName}`).toContain(envName);
    }

    for (const profileId of requiredProfileIds) {
      expect(docs, `docs missing ${profileId}`).toContain(profileId);
    }

    expect(docs).toContain("fixture-degraded");
    expect(docs).toContain("VITE_HONUA_INCIDENT_STREAM_URL");
    expect(docs).toContain("HONUA_CLOUD_DEMO_ALLOW_WRITES");
    expect(docs).toContain("Metadata is cacheable by default");
    expect(docs).toContain("Feature-result caches are never authoritative incident state");
    expect(docs).toContain("ad hoc spatial requests");
  });
});
