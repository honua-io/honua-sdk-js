import { describe, expect, it, vi } from "vitest";
import { CapabilityUnavailableError, capabilityUnavailablePayload } from "../src/capability.js";
import * as stylesResource from "../src/resources/styles.js";
import { STYLE_SURFACE, listStyles, resolveStyleRef } from "../src/styles.js";
import * as applyStylePreset from "../src/tools/apply-style-preset.js";
import * as getStyle from "../src/tools/get-style.js";
import * as listServices from "../src/tools/list-services.js";
import { type MockHonuaClient, asClient, createMockClient } from "./test-helpers.js";

/**
 * Platform-free capability degradation (issue #369, REQ-001).
 *
 * Against a PLAIN public FeatureServer with no Honua surfaces, the Honua-only
 * tools must degrade gracefully — a structured "not available on this target"
 * result — never crash, hang, or return misleading empty data.
 */

/** A plain FeatureServer: the OGC API - Styles probe always fails (404). */
function plainClient(overrides: Partial<MockHonuaClient> = {}): MockHonuaClient {
  return createMockClient({
    pipelineFetch: vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    ...overrides,
  });
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("capability payload helper", () => {
  it("builds a structured non-error unavailable body", () => {
    const body = capabilityUnavailablePayload("X", "why", "do this instead");
    expect(body).toEqual({ available: false, surface: "X", reason: "why", guidance: "do this instead" });
  });
});

describe("styles surface probing", () => {
  it("throws CapabilityUnavailableError when /ogc/styles 404s", async () => {
    await expect(listStyles(asClient(plainClient()))).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("throws when the pipeline itself rejects (SDK non-2xx throw / network error)", async () => {
    const client = createMockClient({
      pipelineFetch: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(listStyles(asClient(client))).rejects.toMatchObject({ surface: STYLE_SURFACE });
  });

  it("throws when the body is not a styles document (no misleading empty catalog)", async () => {
    const client = createMockClient({
      pipelineFetch: vi.fn(async () => new Response(JSON.stringify({ notStyles: true }), { status: 200 })),
    });
    await expect(listStyles(asClient(client))).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("still returns an empty (but present) styles list from a real styles surface", async () => {
    const client = createMockClient({
      pipelineFetch: vi.fn(async () => new Response(JSON.stringify({ styles: [] }), { status: 200 })),
    });
    await expect(listStyles(asClient(client))).resolves.toEqual({ styles: [] });
  });

  it("resolveStyleRef degrades when the stylesheet 404s", async () => {
    await expect(resolveStyleRef(asClient(plainClient()), "topographic")).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );
  });
});

describe("honua_get_style degradation", () => {
  it("reports unavailable (non-error) when listing styles on a plain endpoint", async () => {
    const result = await getStyle.execute(asClient(plainClient()), getStyle.schema.parse({}));
    const body = parse(result.content[0].text);
    expect(body.available).toBe(false);
    expect(body.surface).toBe(STYLE_SURFACE);
    expect(String(body.guidance)).toContain("client-side");
  });

  it("reports unavailable for a specific styleId", async () => {
    const result = await getStyle.execute(asClient(plainClient()), getStyle.schema.parse({ styleId: "topographic" }));
    expect(parse(result.content[0].text).available).toBe(false);
  });
});

describe("honua_apply_style_preset degradation", () => {
  it("reports unavailable instead of crashing", async () => {
    const result = await applyStylePreset.execute(
      asClient(plainClient()),
      applyStylePreset.schema.parse({ styleId: "topographic" }),
    );
    const body = parse(result.content[0].text);
    expect(body.available).toBe(false);
    expect(body.surface).toBe(STYLE_SURFACE);
  });
});

describe("styles resource degradation", () => {
  it("catalog read returns a structured unavailable body", async () => {
    const result = await stylesResource.readCatalog(asClient(plainClient()));
    expect(parse(result.contents[0].text).available).toBe(false);
  });

  it("single-style read returns a structured unavailable body", async () => {
    const result = await stylesResource.read(asClient(plainClient()), "topographic");
    const body = parse(result.contents[0].text);
    expect(body.available).toBe(false);
    expect(result.contents[0].uri).toBe("honua://styles/topographic");
  });
});

describe("honua_list_services degradation", () => {
  it("reports catalogAvailable=false when /rest/services is absent", async () => {
    const client = plainClient({
      listServices: vi.fn(async () => {
        throw new Error("HTTP 404 for /rest/services");
      }),
    });
    const result = await listServices.execute(asClient(client), listServices.schema.parse({}));
    const body = parse(result.content[0].text);
    expect(body.catalogAvailable).toBe(false);
    expect(body.services).toEqual([]);
    expect(String(body.reason)).toContain("not available");
  });

  it("still lists services when the catalog IS present", async () => {
    const result = await listServices.execute(asClient(createMockClient()), listServices.schema.parse({}));
    const body = parse(result.content[0].text) as unknown as Array<{ serviceId: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((s) => s.serviceId)).toContain("Parks");
  });
});
