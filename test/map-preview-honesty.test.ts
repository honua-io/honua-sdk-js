/**
 * "Preview is never reported as persisted or published" (honua-sdk-js#1426).
 *
 * The guarantee is enforced by *absence*, at every boundary where this SDK
 * emits a map artifact or a record of a map operation:
 *
 * 1. the portable map artifact (`exportMapPackage` / `importMapPackage`),
 * 2. the command receipt every transport renders (`HonuaCommandRuntime`),
 * 3. the signed NL-plan receipt (`src/nl-map-control`),
 * 4. the CLI's rendering of a publish receipt,
 * 5. the generated-app manifest projected from a map package.
 *
 * Every assertion below is made on the **serialized form** — the bytes a CLI
 * writes, the canonical receipt JSON an audit join reads, the manifest a host
 * persists — rather than on an internal flag, because a flag that says
 * "preview" is only as good as the producer that set it, while a URL that is
 * not in the bytes cannot be believed by anyone.
 *
 * Deliberately *not* tested here: that a package declares itself a preview.
 * The SDK mints no lifecycle vocabulary of its own — the ephemeral-preview →
 * draft → saved-version → proposal → publication model belongs to the
 * honua-server composition contract and reaches the SDK through #1397 / #1398
 * (`test/runtime/map-package-schema-drift.test.ts` fails if it is smuggled in
 * here). What the SDK owes is the negative guarantee: an artifact that cannot
 * know whether it was persisted never says that it was.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type HonuaCommand,
  createHonuaCommandRuntime,
  mapPackagePublishCommand,
  serializeHonuaCommandReceipt,
} from "../src/control-plane/index.js";
import { projectMapPackageToGeneratedAppManifest } from "../src/generated-app/index.js";
import { HonuaClient } from "../src/index.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  HonuaMapPackageError,
  exportMapPackage,
  importMapPackage,
  mapPackageFingerprint,
} from "../src/runtime/index.js";

const PUBLICATION_URL = "https://maps.example.com/published/pkg-1426";

/**
 * A package as a *server preview* plausibly arrives: composed but not saved,
 * carrying a rendered-preview reference and an expiry, and stamped by the
 * server with the additive location fields the wire format permits
 * (`honua_map_package.v1` is `additionalProperties: true` everywhere).
 */
function previewPackage(overrides: Record<string, unknown> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-1426",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Composing",
    previewArtifactId: "preview-artifact-77",
    expiresAt: "2099-01-01T00:00:00.000Z",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://gis.example.com/arcgis/rest/services/Parcels/FeatureServer", layerId: 0 },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
    },
    attribution: [{ text: "City of Example", url: "https://example.com/credits" }],
    ...overrides,
  } as unknown as HonuaMapPackage;
}

describe("the portable map artifact never asserts where the map is published", () => {
  it("withholds package-level location pointers from the exported bytes", () => {
    const pkg = previewPackage({
      links: { self: PUBLICATION_URL, related: `${PUBLICATION_URL}/versions/3` },
      publicationUrl: PUBLICATION_URL,
      embedUrl: `${PUBLICATION_URL}/embed`,
      permalink: PUBLICATION_URL,
    });

    const envelope = exportMapPackage(pkg, { exportedAt: "2026-01-02T00:00:00.000Z" });
    const bytes = JSON.stringify(envelope);

    // The bytes are the guarantee: nothing a reader of this file can quote
    // says the map is hosted anywhere.
    expect(bytes).not.toContain(PUBLICATION_URL);
    expect(bytes).not.toContain("maps.example.com");
    for (const key of ["links", "publicationUrl", "embedUrl", "permalink"]) {
      expect(Object.hasOwn(envelope.mapPackage, key), key).toBe(false);
    }

    // Withheld, not silently dropped: each one is auditable.
    expect([...envelope.redactions].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "embedUrl", reason: "publication-pointer" },
      { path: "links", reason: "publication-pointer" },
      { path: "permalink", reason: "publication-pointer" },
      { path: "publicationUrl", reason: "publication-pointer" },
    ]);

    // And the URLs that address *data* and *credit* rather than a publication
    // of this map are untouched — the rule is about the claim, not about URLs.
    expect(envelope.mapPackage.sourceBindings[0].locator.url).toBe(
      "https://gis.example.com/arcgis/rest/services/Parcels/FeatureServer",
    );
    expect(envelope.mapPackage.attribution?.[0]?.url).toBe("https://example.com/credits");

    // The stamped fingerprint describes what was emitted, so the envelope
    // still imports cleanly.
    expect(envelope.fingerprint).toBe(mapPackageFingerprint(envelope.mapPackage));
    expect(() => importMapPackage(JSON.parse(bytes))).not.toThrow();
  });

  it("matches location keys by name, ignoring case and separators", () => {
    const envelope = exportMapPackage(
      previewPackage({ "PUBLICATION-URL": PUBLICATION_URL, public_url: PUBLICATION_URL }),
    );
    expect(JSON.stringify(envelope)).not.toContain(PUBLICATION_URL);
    expect(envelope.redactions.map((r) => r.reason)).toEqual(["publication-pointer", "publication-pointer"]);
  });

  it("refuses an envelope that had a location pointer put back into it", () => {
    const envelope = exportMapPackage(previewPackage());
    // Forge the file the exporter would never write, and re-stamp it so the
    // integrity check cannot be what catches it.
    const forged = JSON.parse(JSON.stringify(envelope)) as {
      fingerprint: string;
      mapPackage: Record<string, unknown>;
    };
    forged.mapPackage.links = { self: PUBLICATION_URL };
    forged.fingerprint = mapPackageFingerprint(forged.mapPackage as unknown as HonuaMapPackage);

    expect(() => importMapPackage(forged)).toThrow(HonuaMapPackageError);
    expect(() => importMapPackage(forged)).toThrow(/location pointer/i);
    // Not merely an integrity complaint: the fingerprint agrees with the body.
    expect(() => importMapPackage(forged)).not.toThrow(/fingerprint/i);
  });

  it("refuses a publication claim smuggled onto the envelope beside the package", () => {
    // The package body is untouched and its fingerprint is correct, so every
    // check that looks only at `mapPackage` passes. The claim rides on the
    // envelope — which is itself an artifact a reader will believe.
    for (const smuggled of [{ publicationUrl: PUBLICATION_URL }, { links: { self: PUBLICATION_URL } }]) {
      const forged = { ...JSON.parse(JSON.stringify(exportMapPackage(previewPackage()))), ...smuggled };
      const key = Object.keys(smuggled)[0];
      expect(() => importMapPackage(forged), key).toThrow(HonuaMapPackageError);
      expect(() => importMapPackage(forged), key).toThrow(new RegExp(`location pointer.*\\b${key}\\b`, "i"));
      expect(() => importMapPackage(forged), key).not.toThrow(/fingerprint/i);
    }
  });

  it("refuses a publication claim smuggled beneath an open container in the package", () => {
    // `honua_map_package.v1` is `additionalProperties: true` at every level, so
    // a producer can put the claim anywhere. A name that means "published"
    // means it at every depth.
    const nested: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["mapPackage.metadata.publicationUrl", { metadata: { publicationUrl: PUBLICATION_URL } }],
      ["mapPackage.metadata.records[0].embedUrl", { metadata: { records: [{ embedUrl: PUBLICATION_URL }] } }],
      [
        "mapPackage.widgets[0].config.permalink",
        { widgets: [{ widgetId: "w", type: "legend", config: { permalink: PUBLICATION_URL } }] },
      ],
    ];
    for (const [path, smuggled] of nested) {
      const forged = JSON.parse(JSON.stringify(exportMapPackage(previewPackage()))) as {
        fingerprint: string;
        mapPackage: Record<string, unknown>;
      };
      Object.assign(forged.mapPackage, smuggled);
      forged.fingerprint = mapPackageFingerprint(forged.mapPackage as unknown as HonuaMapPackage);

      expect(() => importMapPackage(forged), path).toThrow(HonuaMapPackageError);
      expect(() => importMapPackage(forged), path).toThrow(new RegExp(path.replace(/[.[\]]/g, "\\$&"), "i"));
      expect(() => importMapPackage(forged), path).not.toThrow(/fingerprint/i);
    }
  });

  it("withholds a nested publication claim on export, so the exporter never emits what its importer refuses", () => {
    const pkg = previewPackage({
      metadata: { publicationUrl: PUBLICATION_URL, note: "composed for review" },
    });
    const envelope = exportMapPackage(pkg);
    const bytes = JSON.stringify(envelope);

    expect(bytes).not.toContain(PUBLICATION_URL);
    expect(envelope.redactions).toContainEqual({ path: "metadata.publicationUrl", reason: "publication-pointer" });

    // Asserted on the imported package, not on the exporter's intermediate:
    // the container survives, only the claim is gone, and the artifact the
    // exporter produced is one its own importer accepts.
    const imported = importMapPackage(JSON.parse(bytes)).mapPackage as unknown as {
      metadata: Record<string, unknown>;
    };
    expect(imported.metadata).toEqual({ note: "composed for review" });
  });

  it("leaves every URL that addresses data, a sprite, a credit, or a symbol byte-identical", () => {
    // The counterweight to the two tests above. The rule is name-directed, so
    // deepening the scan must not start refusing the nested URLs a map package
    // legitimately carries — `mapSpec.sprite[i].url` is required by the schema.
    const pkg = previewPackage({
      mapSpec: {
        version: 8,
        sources: { basemap: { type: "vector", url: "https://tiles.example.com/basemap/tiles.json" } },
        sprite: [{ id: "default", url: "https://tiles.example.com/sprites/default" }],
        glyphs: "https://tiles.example.com/fonts/{fontstack}/{range}.pbf",
        layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
      },
      legend: [{ label: "Parcels", iconUrl: "https://cdn.example.com/icons/parcel.svg" }],
      widgets: [{ widgetId: "info", type: "info", config: { links: [{ href: "https://example.com/help" }] } }],
    });

    const envelope = exportMapPackage(pkg);
    expect(envelope.redactions).toEqual([]);
    expect(importMapPackage(JSON.parse(JSON.stringify(envelope))).mapPackage).toEqual(pkg);
  });
});

describe("a command receipt never links to a resource the command did not create", () => {
  function runtimeFor(fetchFn: typeof fetch) {
    return createHonuaCommandRuntime({ client: new HonuaClient({ baseUrl: "https://example.test", fetchFn }) });
  }

  function neverCalled(): typeof fetch {
    return (async () => {
      throw new Error("a dry run must not reach the network");
    }) as unknown as typeof fetch;
  }

  it("strips a resource link a plan predicts, on the dry run and on the recorded plan", async () => {
    // A command that predicts where its result will live. Nothing in the
    // catalog does this today; the guarantee has to hold for the one that
    // tries, because a dry run *is* its plan.
    const optimistic: HonuaCommand<{ readonly mapId: string }, unknown> = {
      id: "test.optimistic-publish",
      title: "Publish, optimistically",
      description: "Predicts the published location of a map that has not been published.",
      mode: "action",
      resourceKind: "map-package",
      inputSchema: {
        type: "object",
        properties: { mapId: { type: "string", minLength: 1 } },
        required: ["mapId"],
        additionalProperties: false,
      },
      plan(context) {
        return {
          method: "POST",
          path: "/packages",
          summary: `Publish ${context.input.mapId}`,
          resourceRef: { type: "map-package", id: context.input.mapId, href: PUBLICATION_URL },
        };
      },
      async execute() {
        throw new Error("unreachable in a dry run");
      },
    };

    const receipt = await runtimeFor(neverCalled()).execute(
      optimistic,
      { mapId: "map-ops" },
      {
        transport: "cli",
        dryRun: true,
      },
    );

    expect(receipt.status).toBe("dry-run");
    expect(receipt.plan.resourceRef).toEqual({ type: "map-package", id: "map-ops" });
    expect(receipt.resourceRef).toEqual({ type: "map-package", id: "map-ops" });

    // The canonical serialization is what a receipt store and an audit join
    // read. No URL survives into it, and no `href` key either.
    const serialized = serializeHonuaCommandReceipt(receipt);
    expect(serialized).not.toContain(PUBLICATION_URL);
    expect(serialized).not.toContain("href");
    // The audit key hashes that projection, so it agrees with the bytes.
    expect(receipt.auditKey).toBe(
      (await runtimeFor(neverCalled()).execute(optimistic, { mapId: "map-ops" }, { transport: "mcp", dryRun: true }))
        .auditKey,
    );
  });

  it("reports no package identity or link when `map-package.publish` is previewed, and both when it runs", async () => {
    const published = {
      packageId: "pkg-ops-42",
      links: { self: "https://example.test/api/v1/admin/packages/pkg-ops-42" },
    };
    const mapPackage = { id: "pkg-ops", version: "1.0.0", layers: [] } as unknown as HonuaMapPackage;

    const preview = await runtimeFor(neverCalled()).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: mapPackage },
      { transport: "cli", dryRun: true },
    );
    const previewBytes = serializeHonuaCommandReceipt(preview);
    expect(preview.status).toBe("dry-run");
    expect(preview.resourceRef).toEqual({ type: "map-package" });
    expect(previewBytes).not.toContain("pkg-ops-42");
    expect(previewBytes).not.toContain("https://");

    const fetchFn = (async () =>
      new Response(JSON.stringify(published), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const executed = await runtimeFor(fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", package: mapPackage },
      { transport: "cli" },
    );

    // The executed path is unchanged: a link appears once, and only once, the
    // *server* has returned one.
    expect(executed.status).toBe("ok");
    expect(executed.resourceRef?.id).toBe("pkg-ops-42");
    expect(executed.resourceRef?.href).toBe(published.links.self);
  });

  it("prints no package identity under the CLI's dry-run heading", async () => {
    const { run } = await import("../src/cli/main.js");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.stubGlobal("fetch", neverCalled());
    try {
      const code = await run([
        "map",
        "publish",
        "map-ops",
        "--package",
        JSON.stringify({ id: "pkg-ops" }),
        "--dry-run",
        "--base-url",
        "https://example.test",
        "--api-key",
        "key",
      ]);
      expect(code).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    const rendered = output.join("");
    expect(rendered).toContain("dry run");
    expect(rendered).toContain("(not assigned)");
    expect(rendered).not.toMatch(/https?:\/\//);
  });
});

describe("a signed NL-plan receipt never reports a previewed step as a completed one", () => {
  it("refuses a plan whose step carries `dryRun`, before anything executes", async () => {
    const { NL_MAP_CONTROL_VERSION, NL_MAP_PLAN_KIND, createNlMapControl, hashNlMapPlan } = await import(
      "../src/nl-map-control/index.js"
    );
    const control = createNlMapControl({
      tools: {
        runtime: {
          id: "nl-preview-honesty",
          listSources: () => [],
          listLayers: () => [{ id: "parcels-fill", sourceId: "parcels", type: "fill", visible: true }],
          getViewport: () => ({ center: [0, 0], zoom: 1 }),
          getSelection: () => [],
          setVisibility: () => {
            throw new Error("a refused plan must not execute any step");
          },
        } as never,
      },
      llm: async () => {
        throw new Error("execute() must not consult the model");
      },
    });

    // `propose` deletes `dryRun` ("plans stay pure"), so build the plan the way
    // a caller with a hand-assembled document would — and give it the
    // self-consistent fingerprint that a content-addressed check cannot fault,
    // so the refusal below can only be about the preview argument.
    const draft = {
      instruction: "hide the parcels layer",
      attempt: 1,
      readOnly: false,
      effects: ["mutation"],
      steps: [
        {
          id: "step-1",
          tool: "setVisibility",
          effect: "mutation",
          call: { name: "setVisibility", args: { layerId: "parcels-fill", visible: false, dryRun: true } },
        },
      ],
    };
    const plan = {
      kind: NL_MAP_PLAN_KIND,
      version: NL_MAP_CONTROL_VERSION,
      id: "nlplan_forged",
      ...draft,
      fingerprint: "sha256:placeholder",
    } as never;
    const withFingerprint = { ...(plan as object), fingerprint: hashNlMapPlan(plan) } as never;

    // `plan-invalid`, not `approval-required`: the refusal lands in plan
    // validation, ahead of the approval gate. Before this guard the same plan
    // reached that gate, and an approval bound to this exact fingerprint would
    // have carried it into execution — where every step returns "dry-run",
    // nothing happens, and the receipt is signed `outcome: "succeeded"`.
    await expect(control.execute(withFingerprint)).rejects.toThrow(/dryRun/);
    await expect(control.execute(withFingerprint)).rejects.toMatchObject({ code: "plan-invalid" });
  });
});

describe("the CLI never prints a publication heading for a publication that did not happen", () => {
  it("titles every non-ok receipt status by what actually happened", async () => {
    const { mapPublishHeading } = await import("../src/cli/commands/map.js");
    expect(mapPublishHeading("ok")).toBe("Map package published");
    for (const status of ["dry-run", "denied", "cancelled", "error"] as const) {
      expect(mapPublishHeading(status), status).not.toBe("Map package published");
      expect(mapPublishHeading(status), status).not.toMatch(/\bpublished\b/);
    }
    // An unrecognized future status must not inherit the successful heading.
    expect(mapPublishHeading("queued" as never)).not.toMatch(/\bpublished\b/);
  });
});

describe("a generated-app manifest never takes its identity from a preview", () => {
  it("identifies the app by the map package, not by its rendered preview artifact", () => {
    const manifest = projectMapPackageToGeneratedAppManifest(previewPackage());

    expect(manifest.appId).toBe("pkg-1426");
    expect(manifest.appId).not.toBe("preview-artifact-77");
    expect(manifest.mapPackageId).toBe("pkg-1426");

    // The preview reference is not erased — it stays where it means "a preview
    // was rendered", and nowhere that means "this is the thing's identity".
    const serialized = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown> & {
      mapPackage?: Record<string, unknown>;
    };
    expect(serialized.mapPackage?.previewArtifactId).toBe("preview-artifact-77");
    for (const [key, value] of Object.entries(serialized)) {
      if (key === "mapPackage" || key === "metadata") continue;
      expect(value, key).not.toBe("preview-artifact-77");
    }
  });
});
