/**
 * Security eval — **shared-admin fallback** (honua-sdk-js#1425, AC "Security
 * evals reject … shared-admin fallback …").
 *
 * The property under test: *no journey verb ever silently reaches for the
 * shared root administrator credential.*
 *
 * `honua admin <group> <operationId>` deliberately *does* want a separate root
 * admin credential — it is the generic escape hatch onto the full 396-operation
 * Admin API, and asking for `--admin-key` / `HONUA_ADMIN_KEY` explicitly is the
 * whole point of it. That is not a fallback. A fallback is what would happen if
 * `honua map publish`, `honua services`, an import, a Studio save, or a
 * geocode quietly picked the root key up out of the environment because the
 * caller's own credential was absent or insufficient: every one of those verbs
 * would then run at root privilege, in a session nobody scoped, with an audit
 * trail that says "admin" for work a scoped principal asked for.
 *
 * The separation is structural — two resolver functions, two client classes —
 * rather than a runtime assertion, and structure is exactly the kind of
 * guarantee that erodes silently under a refactor. Nothing in the repository
 * tested it before this suite: `resolveConnection` had no direct test, and no
 * test asserted that an ordinary verb run with `HONUA_ADMIN_KEY` set puts none
 * of it on the wire. These evals drive the real resolvers and the real CLI with
 * a root credential planted in every place one could come from, and assert on
 * the recorded bytes.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient, createCommandRuntime, createGeocodingClient } from "../../src/cli/client.js";
import { type HonuaCliConfig, resolveAdminConnection, resolveConnection, writeConfig } from "../../src/cli/config.js";
import { run } from "../../src/cli/main.js";
import {
  HONUA_COMMANDS,
  HONUA_COMMAND_IDS,
  HonuaAdminClient,
  type HonuaAnyCommand,
  createHonuaCommandRuntime,
  isHonuaCommandError,
} from "../../src/control-plane/index.js";
import { HonuaClient } from "../../src/index.js";
import type { HonuaMapPackage } from "../../src/runtime/index.js";
import { PLANTED, recorder, wireBytes } from "./harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_URL = "https://control.example.test";
const SCOPED_KEY = "scoped-caller-key-9f2a";
const MAP_PACKAGE = { id: "pkg-eval", version: "1.0.0", layers: [] } as unknown as HonuaMapPackage;

const VALID_INPUT: Readonly<Record<string, Record<string, unknown>>> = {
  "connection.test": { connectionId: "conn-1" },
  "import.create": { sourceKind: "geojson", sourceUrl: "https://data.example.test/a.geojson" },
  "map-package.publish": { package: MAP_PACKAGE },
  "studio.draft.saveVersion": { draftId: "draft-1" },
};

const scratchDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

/**
 * A private CLI config file with the root admin key saved in a profile — the
 * most dangerous of the three places one can live, because it survives the
 * shell that set it.
 */
async function configWithAdminKey(config: HonuaCliConfig): Promise<NodeJS.ProcessEnv> {
  const dir = mkdtempSync(join(tmpdir(), "honua-1425-admin-"));
  scratchDirs.push(dir);
  const env: NodeJS.ProcessEnv = { HONUA_CONFIG_HOME: join(dir, "honua") };
  await writeConfig(config, env);
  return env;
}

// ───────────────────────────────────────────────────────────────────────────
// Resolution — the two functions that decide which credential a surface gets
// ───────────────────────────────────────────────────────────────────────────

describe("shared-admin fallback :: credential resolution", () => {
  it("never lets an ordinary verb see the root admin key, from any of its three sources", async () => {
    // Attacker/confused agent: sets `HONUA_ADMIN_KEY` once — because a skill
    // step needed `honua admin` — and every subsequent `honua` command in that
    // shell silently escalates. `resolveConnection` is the one function every
    // journey verb goes through, and its return type has no field to put the
    // root key in at all.
    const env = await configWithAdminKey({
      baseUrl: BASE_URL,
      profiles: { ops: { baseUrl: BASE_URL, adminKey: PLANTED.rootAdminLiteral } },
    });
    env.HONUA_ADMIN_KEY = PLANTED.rootAdminLiteral;

    for (const profile of [undefined, "ops"]) {
      const resolved = resolveConnection({ env, ...(profile ? { profile } : {}) });
      expect(resolved.apiKey, `profile=${profile ?? "(none)"} must resolve no credential`).toBeUndefined();
      expect(JSON.stringify(resolved)).not.toContain(PLANTED.rootAdminLiteral);
      expect(Object.keys(resolved)).not.toContain("adminKey");
    }
  });

  it("keeps the caller's own scoped key when one exists, rather than preferring the root key", async () => {
    // The subtler failure: both credentials are present and the resolver picks
    // the more powerful one "because it will definitely work".
    const env = await configWithAdminKey({
      baseUrl: BASE_URL,
      profiles: { ops: { baseUrl: BASE_URL, apiKey: SCOPED_KEY, adminKey: PLANTED.rootAdminLiteral } },
    });
    env.HONUA_ADMIN_KEY = PLANTED.rootAdminLiteral;
    const resolved = resolveConnection({ env, profile: "ops" });
    expect(resolved.apiKey).toBe(SCOPED_KEY);
  });

  it("gives the admin escape hatch the root key explicitly, and degrades downward and never upward", async () => {
    // The control that keeps the eval above from being vacuous: the separation
    // is real in both directions. `resolveAdminConnection` *does* surface the
    // root key — that is the escape hatch working — and when no root key exists
    // it falls back DOWN to the caller's scoped key, which is a privilege
    // reduction. The forbidden direction is an ordinary verb reaching UP.
    const withRoot = await configWithAdminKey({ baseUrl: BASE_URL });
    withRoot.HONUA_ADMIN_KEY = PLANTED.rootAdminLiteral;
    expect(resolveAdminConnection({ env: withRoot }).adminKey).toBe(PLANTED.rootAdminLiteral);

    const withoutRoot = await configWithAdminKey({ baseUrl: BASE_URL, apiKey: SCOPED_KEY });
    expect(resolveAdminConnection({ env: withoutRoot }).adminKey).toBe(SCOPED_KEY);
    expect(resolveConnection({ env: withoutRoot }).apiKey).toBe(SCOPED_KEY);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The CLI client factories every journey verb is built from
// ───────────────────────────────────────────────────────────────────────────

describe("shared-admin fallback :: the CLI's client factories", () => {
  it("builds no journey client that carries the root admin key", async () => {
    // Every ordinary `honua` verb — services, layers, query, stac, geocode,
    // map publish — obtains its client from exactly these three factories.
    // Proving the factories are clean proves the verbs are, without enumerating
    // a command list that the next feature will make stale.
    const env = await configWithAdminKey({
      baseUrl: BASE_URL,
      profiles: { ops: { baseUrl: BASE_URL, adminKey: PLANTED.rootAdminLiteral } },
    });
    vi.stubEnv("HONUA_ADMIN_KEY", PLANTED.rootAdminLiteral);
    vi.stubEnv("HONUA_CONFIG_HOME", env.HONUA_CONFIG_HOME as string);
    vi.stubEnv("HONUA_API_KEY", "");

    const capture = recorder(() => ({ body: { services: [] } }));
    vi.stubGlobal("fetch", capture.fetchFn);

    const client = createClient({ baseUrl: BASE_URL, profile: "ops" });
    await client.listServices().catch(() => undefined);
    createGeocodingClient({ baseUrl: BASE_URL, profile: "ops" });
    createCommandRuntime({ baseUrl: BASE_URL, profile: "ops" });

    expect(capture.requests.length).toBeGreaterThan(0);
    expect(wireBytes(capture.requests)).not.toContain(PLANTED.rootAdminLiteral);
    for (const request of capture.requests) {
      expect(request.headers["x-honua-admin-key"]).toBeUndefined();
      expect(request.headers["x-api-key"]).toBeUndefined();
    }
  });

  it("puts no byte of the root admin key on the wire when a real publish runs with one in the environment", async () => {
    // End to end through `run()`, the way an agent actually invokes it: the
    // root key is in the environment *and* in the saved profile, and the verb
    // is a mutating publish. The request must carry the caller's scoped key and
    // nothing else.
    const env = await configWithAdminKey({
      baseUrl: BASE_URL,
      profiles: { ops: { baseUrl: BASE_URL, apiKey: SCOPED_KEY, adminKey: PLANTED.rootAdminLiteral } },
    });
    vi.stubEnv("HONUA_ADMIN_KEY", PLANTED.rootAdminLiteral);
    vi.stubEnv("HONUA_CONFIG_HOME", env.HONUA_CONFIG_HOME as string);

    const capture = recorder(() => ({ body: { packageId: "pkg-1" } }));
    vi.stubGlobal("fetch", capture.fetchFn);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exitCode = await run([
      "map",
      "publish",
      "map-ops",
      "--package",
      JSON.stringify(MAP_PACKAGE),
      "--profile",
      "ops",
      "--yes",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.headers["x-api-key"]).toBe(SCOPED_KEY);
    expect(wireBytes(capture.requests)).not.toContain(PLANTED.rootAdminLiteral);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The shared command layer
// ───────────────────────────────────────────────────────────────────────────

describe("shared-admin fallback :: the shared command layer", () => {
  it("runs every command on the caller's own credential with a root key sitting in the environment", async () => {
    // Attacker: the command layer is the one place all four transports meet, so
    // an admin-key fallback there would escalate CLI, MCP, Studio, and SDK at
    // once. `HonuaCommandRuntime` is built from a `HonuaClient` and has no
    // `HonuaAdminClient` dependency — this drives every catalog command with the
    // root key planted in the environment to prove the runtime never reads it.
    vi.stubEnv("HONUA_ADMIN_KEY", PLANTED.rootAdminLiteral);
    for (const id of HONUA_COMMAND_IDS) {
      if (id === "studio.draft.saveVersion") continue; // needs a Studio client; covered below
      const capture = recorder(() => ({ body: { jobId: "job-1", packageId: "pkg-1", ok: true } }));
      const runtime = createHonuaCommandRuntime({
        client: new HonuaClient({ baseUrl: BASE_URL, apiKey: SCOPED_KEY, fetchFn: capture.fetchFn, transport: "rest" }),
      });
      await runtime.execute(HONUA_COMMANDS[id] as HonuaAnyCommand, VALID_INPUT[id] as never, { transport: "mcp" });
      expect(capture.requests.length, `${id} must issue a request`).toBeGreaterThan(0);
      expect(capture.requests[0]?.headers["x-api-key"], `${id} must use the caller's key`).toBe(SCOPED_KEY);
      expect(wireBytes(capture.requests), `${id} must not carry the root key`).not.toContain(PLANTED.rootAdminLiteral);
    }
  });

  it("fails a Studio command outright rather than reaching for another credential when its client is absent", async () => {
    // The exact moment a fallback would be tempting: the runtime cannot serve
    // the command with what it has. The honest answer is a `transport` error
    // naming the missing dependency — not a second credential, and not a
    // silent switch to the admin API that happens to expose a similar route.
    vi.stubEnv("HONUA_ADMIN_KEY", PLANTED.rootAdminLiteral);
    const capture = recorder();
    const runtime = createHonuaCommandRuntime({
      client: new HonuaClient({ baseUrl: BASE_URL, apiKey: SCOPED_KEY, fetchFn: capture.fetchFn, transport: "rest" }),
    });
    await expect(
      runtime.execute(HONUA_COMMANDS["studio.draft.saveVersion"] as HonuaAnyCommand, { draftId: "draft-1" } as never, {
        transport: "cli",
      }),
    ).rejects.toSatisfy((error: unknown) => isHonuaCommandError(error) && error.kind === "transport");
    expect(capture.requests).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The escape hatch itself — explicit, separate, and non-contagious
// ───────────────────────────────────────────────────────────────────────────

describe("shared-admin fallback :: the honua admin escape hatch", () => {
  it("cannot be reached from an ordinary client, because it is a different class", async () => {
    // Attacker: looks for a method, property, or option on the ordinary client
    // tree that upgrades it. `HonuaAdminClient` takes a raw baseUrl and its own
    // credential and accepts no `HonuaClient`, so there is no type-level or
    // runtime path from a scoped session into the admin API.
    const capture = recorder(() => ({ body: {} }));
    const scoped = new HonuaClient({ baseUrl: BASE_URL, apiKey: SCOPED_KEY, fetchFn: capture.fetchFn });
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(scoped) as object)) {
      expect(name, `HonuaClient.${name} must not expose an admin upgrade`).not.toMatch(/admin|elevate|escalate|root/i);
    }
    // And the admin client refuses the transport shapes that would leak its
    // credential in the first place.
    expect(
      () => new HonuaAdminClient({ baseUrl: "http://admin.example.test", adminKey: PLANTED.rootAdminLiteral }),
    ).toThrow(/HTTPS/);
    expect(
      () => new HonuaAdminClient({ baseUrl: "https://x:y@admin.example.test", adminKey: PLANTED.rootAdminLiteral }),
    ).toThrow(/credentials/);
  });

  it("keeps the stage skills free of any journey step that reaches for the root key", () => {
    // The most likely real path to a shared-admin fallback is not a code defect
    // at all: it is a skill that tells the agent to "just export
    // HONUA_ADMIN_KEY" when a scoped credential is refused. Skills load
    // verbatim into agent context, so a single such line makes every agent that
    // reads it escalate. The corpus must contain no such instruction, and the
    // two stages that touch credentials must say the opposite out loud.
    const bodies = readdirSync(resolve(repoRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(
        (entry) =>
          [
            `skills/${entry.name}/SKILL.md`,
            readFileSync(resolve(repoRoot, "skills", entry.name, "SKILL.md"), "utf8"),
          ] as const,
      );
    expect(bodies.length).toBeGreaterThanOrEqual(10);

    for (const [path, body] of bodies) {
      expect(body, `${path} must not hand a journey verb the root key`).not.toMatch(/--admin-key/);
      expect(body, `${path} must not tell an agent to export the root key`).not.toMatch(/HONUA_ADMIN_KEY\s*=/);
    }

    // The positive half: the diagnostics stage — the one an agent reaches when
    // something has already been refused, and therefore the one where the
    // temptation is highest — states the rule directly.
    const diagnostics = new Map(bodies).get("skills/honua-diagnostics/SKILL.md");
    expect(diagnostics).toMatch(/[Nn]ever fall back to a shared admin key/);
    const localSetup = new Map(bodies).get("skills/honua-local-setup/SKILL.md");
    expect(localSetup).toMatch(/escalating to a shared admin key/);
  });

  it("refuses a mutating admin operation without an explicit confirmation", async () => {
    // The escape hatch is explicit at both ends: an explicit root credential in,
    // and an explicit `--yes` before anything mutates. An agent that stumbles
    // into `honua admin` cannot change state by accident.
    const capture = recorder(() => ({ body: {} }));
    vi.stubGlobal("fetch", capture.fetchFn);
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });

    const exitCode = await run([
      "admin",
      "connect",
      "createConnection",
      "--body",
      "{}",
      "--base-url",
      BASE_URL,
      "--admin-key",
      PLANTED.rootAdminLiteral,
    ]);

    expect(exitCode).not.toBe(0);
    expect(printed.join("")).toMatch(/--yes/);
    expect(capture.requests, "a refused admin mutation must issue no request").toHaveLength(0);
  });
});
