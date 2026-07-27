import { describe, expect, it, vi } from "vitest";

import type { HonuaMapPackage } from "../src/runtime/index.js";
import {
  type HonuaExportAdapter,
  HonuaExportSafetyError,
  assertCredentialFreeExportBytes,
  containsCredentialMaterial,
  createBrowserPrintExportAdapter,
  createHonuaExportAdapter,
  extractPrintableRuns,
  runHonuaExport,
} from "../src/web-components/index.js";
import type { HonuaWebComponentState } from "../src/web-components/types.js";

/**
 * Second review round on the secure-export contract (issue #683). One suite per
 * finding, each proving the specific hole is closed rather than that the happy
 * path still works.
 *
 * Kept separate from `web-components-export-security.test.ts` so each finding's
 * regression stays legible next to the defect it covers.
 */

// Assembled at runtime: GitHub push protection matches the literal form.
const STRIPE_SHAPED_TOKEN = ["sk", "live", "abcdefghijklmnop1234567890"].join("_");
const SECRETS = {
  bearer: `Bearer ${STRIPE_SHAPED_TOKEN}`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  azureSas: "https://tiles.blob.core.windows.net/basemap/{z}/{x}/{y}.pbf?sv=2021-08-06&sig=abc123DEFghi456JKLmno789",
  presigned:
    "https://bucket.s3.amazonaws.com/tiles.pmtiles?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=deadbeefcafebabe1234567890abcdef",
  apiKeyUrl: "https://api.maptiler.com/maps/streets/style.json?key=ABCdefGHIjklMNOpqrsT",
} as const;

function attributedState(): HonuaWebComponentState {
  const mapPackage: HonuaMapPackage = {
    mapPackageId: "incident-response",
    format: "honua_map_package.v1",
    license: "CC-BY 4.0 — Example Data Cooperative",
    sourceBindings: [
      {
        sourceId: "roads",
        protocol: "geoservices_feature_service",
        locator: { url: "https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0", layerId: 0 },
        attribution: "© Example DOT",
      },
    ],
    mapSpec: { version: 8, sources: {}, layers: [] } as unknown as HonuaMapPackage["mapSpec"],
  };
  return {
    packageId: "incident-response",
    status: "ready",
    mapPackage,
    layers: [{ id: "roads-line", title: "Roads", sourceId: "roads", visible: true }],
    legend: [],
    viewport: { center: [-157.85, 21.3], zoom: 12 },
    featuresBySource: {},
    featureStates: [],
    filters: {},
  };
}

/**
 * A buffer that is genuinely binary — it will never decode as UTF-8 — with a
 * readable text chunk inside, the way a PNG `tEXt` chunk, a JPEG `COM` marker,
 * or a PDF/XMP metadata string carries text inside an opaque file.
 */
function binaryWithEmbeddedText(text: string): Uint8Array {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunkLabel = [..."tEXt"].map((character) => character.charCodeAt(0));
  const ascii = [...text].map((character) => character.charCodeAt(0) & 0xff);
  return Uint8Array.from([
    ...pngMagic,
    // Lone continuation bytes: invalid UTF-8, so a fatal decode of the whole
    // buffer must fail and the text path cannot be what catches the token.
    0x80,
    0x81,
    0xfe,
    0xff,
    0x80,
    ...chunkLabel,
    0x00,
    ...ascii,
    0x00,
    0xff,
    0xfe,
    0x80,
  ]);
}

function snapshotAdapterReturning(bytes: Uint8Array): HonuaExportAdapter {
  return {
    id: "binary",
    describeCapabilities: () => ({ adapterId: "binary", kinds: ["snapshot"], cancellable: false }),
    snapshot: () => ({ mediaType: "image/png", bytes }),
  };
}

describe("finding 1: binary artifacts are swept for credentials too (REQ-002)", () => {
  it("the fixture really is undecodable as UTF-8, so this exercises the binary path", () => {
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(binaryWithEmbeddedText("hello"))).toThrow();
  });

  it("refuses a PNG-shaped buffer carrying a bearer token in a text chunk", async () => {
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: snapshotAdapterReturning(binaryWithEmbeddedText(`Authorization: ${SECRETS.bearer}`)),
      state: attributedState(),
    });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
    expect(result.error).toBeInstanceOf(HonuaExportSafetyError);
  });

  it.each([
    ["signed tile URL", SECRETS.azureSas],
    ["presigned URL", SECRETS.presigned],
    ["jwt", SECRETS.jwt],
    ["api key parameter", SECRETS.apiKeyUrl],
  ])("refuses a binary artifact carrying a %s", async (_label, secret) => {
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: snapshotAdapterReturning(binaryWithEmbeddedText(`XMP:Source=${secret}`)),
      state: attributedState(),
    });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
  });

  it("still passes a clean binary artifact through unchanged", async () => {
    const clean = binaryWithEmbeddedText("Software=Honua Map Export; Copyright=Example DOT");
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: snapshotAdapterReturning(clean),
      state: attributedState(),
    });
    expect(result.status).toBe("ready");
    expect([...(result.bytes ?? [])]).toEqual([...clean]);
  });

  it("does not flag high-entropy compressed data that carries no credential", async () => {
    // Deterministic pseudo-random bytes standing in for an IDAT/DEFLATE payload.
    const noise = new Uint8Array(64 * 1024);
    let seed = 0x2f6e2b1;
    for (let index = 0; index < noise.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[index] = (seed >> 16) & 0xff;
    }
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: snapshotAdapterReturning(noise),
      state: attributedState(),
    });
    expect(result.status).toBe("ready");
  });

  it("catches a token straddling the internal scan-chunk boundary", async () => {
    const chunk = 1 << 20;
    const filler = "Honua export padding. ";
    const prefix = filler.repeat(Math.ceil(chunk / filler.length)).slice(0, chunk - 12);
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: snapshotAdapterReturning(binaryWithEmbeddedText(`${prefix}${SECRETS.bearer}${filler.repeat(64)}`)),
      state: attributedState(),
    });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
  });

  it("extracts printable runs and drops structural noise", () => {
    const bytes = Uint8Array.from([0x00, 0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x00, 0x01, 0x5a, 0x00, 0xfe]);
    // "ABCDE" survives; the lone "Z" is below the minimum run length.
    expect(extractPrintableRuns(bytes)).toBe("ABCDE");
  });

  it("exposes the byte sweep as a standalone assertion", () => {
    expect(() => assertCredentialFreeExportBytes(binaryWithEmbeddedText(SECRETS.bearer), "test artifact")).toThrow(
      HonuaExportSafetyError,
    );
    expect(() =>
      assertCredentialFreeExportBytes(binaryWithEmbeddedText("Copyright Example DOT"), "test artifact"),
    ).not.toThrow();
  });
});

describe("finding 2: a snapshot cannot silently claim attribution it does not carry (REQ-003)", () => {
  /** A 1x1 transparent PNG, as a real canvas would hand back. */
  function fakeCanvas(): { toDataURL: () => string } {
    return {
      toDataURL: () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFVQwPuAAAAAElFTkSuQmCC",
    };
  }

  it("reports provenanceEmbedded false and names what the caller must present", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", snapshot: { getCanvas: fakeCanvas } });
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: attributedState() });

    expect(result.status).toBe("ready");
    // The attribution is still known and still travels on the result...
    expect(result.provenance.attribution).toContain("© Example DOT");
    // ...but the result no longer implies the bytes carry it.
    expect(result.provenanceEmbedded).toBe(false);
    const warnings = result.provenance.fidelityWarnings.join(" ");
    expect(warnings).toContain("do not carry the attribution");
    expect(warnings).toContain("© Example DOT");
    expect(warnings).toContain("CC-BY 4.0 — Example Data Cooperative");
  });

  it("fails closed under requireEmbeddedProvenance when the adapter cannot embed", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", snapshot: { getCanvas: fakeCanvas } });
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter,
      state: attributedState(),
      requireEmbeddedProvenance: true,
    });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
    expect(result.error).toBeInstanceOf(HonuaExportSafetyError);
    expect(result.message).toContain("requireEmbeddedProvenance");
  });

  it("accepts an adapter that genuinely composites attribution, with no warning", async () => {
    const adapter = createHonuaExportAdapter({
      id: "watermarking-app",
      snapshot: { getCanvas: fakeCanvas, provenanceEmbedded: true },
    });
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter,
      state: attributedState(),
      requireEmbeddedProvenance: true,
    });
    expect(result.status).toBe("ready");
    expect(result.provenanceEmbedded).toBe(true);
    expect(result.provenance.fidelityWarnings.join(" ")).not.toContain("do not carry the attribution");
  });

  it("adds no attribution warning when no source requires attribution", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", snapshot: { getCanvas: fakeCanvas } });
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: undefined });
    expect(result.status).toBe("ready");
    expect(result.provenance.fidelityWarnings.join(" ")).not.toContain("do not carry the attribution");
  });

  it("treats a side-effect print as carrying its own provenance", async () => {
    // The browser prints the live page, attribution DOM included.
    const result = await runHonuaExport({
      kind: "print",
      adapter: createBrowserPrintExportAdapter({ print: () => {} }),
      state: attributedState(),
    });
    expect(result.status).toBe("ready");
    expect(result.provenanceEmbedded).toBe(true);
  });
});

describe("finding 3: adapter media types are validated, not merely truncated", () => {
  function adapterWithMediaType(mediaType: string): HonuaExportAdapter {
    return {
      id: "media",
      describeCapabilities: () => ({ adapterId: "media", kinds: ["state"], cancellable: false }),
      exportState: () => ({ mediaType, text: "{}" }),
    };
  }

  it("strips a credential smuggled through a media-type parameter", async () => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterWithMediaType(`text/plain; token=${STRIPE_SHAPED_TOKEN}`),
      state: attributedState(),
    });
    expect(result.status).toBe("ready");
    expect(result.mediaType).toBe("text/plain");
    expect(result.mediaType).not.toContain("token");
    expect(containsCredentialMaterial(JSON.stringify(result))).toBe(false);
    expect(result.provenance.fidelityWarnings.join(" ")).toContain("disallowed media-type parameter");
  });

  it("keeps the one allowlisted parameter", async () => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterWithMediaType("application/json; charset=utf-8"),
      state: attributedState(),
    });
    expect(result.mediaType).toBe("application/json; charset=utf-8");
  });

  it.each([
    ["header injection", "text/plain\r\nX-Injected: 1"],
    ["not a media type at all", "definitely not a media type"],
    ["too many slashes", "text/plain/extra"],
    ["empty subtype", "text/"],
  ])("substitutes a safe default for %s", async (_label, mediaType) => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterWithMediaType(mediaType),
      state: attributedState(),
    });
    expect(result.status).toBe("ready");
    expect(result.mediaType).toBe("application/octet-stream");
    expect(result.mediaType).not.toContain("\n");
    expect(result.provenance.fidelityWarnings.join(" ")).toContain("not a valid type/subtype");
  });

  it("derives the filename extension from the validated media type, not the raw one", async () => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterWithMediaType(`application/json; token=${STRIPE_SHAPED_TOKEN}`),
      state: attributedState(),
      title: "report",
    });
    // This adapter supplies no filenameHint, so the stem is the safe fallback;
    // what matters here is that the extension came from the *validated*
    // `application/json` and that no part of the stripped parameter reached it.
    expect(result.filename).toBe("honua-export.json");
    expect(result.filename?.endsWith(".json")).toBe(true);
    expect(result.filename).not.toContain("token");
    expect(containsCredentialMaterial(result.filename ?? "")).toBe(false);
  });
});

describe("finding 5: a side-effect export still hands back its release obligation", () => {
  it("reports caller-releases and does not pre-release when the adapter holds a resource", async () => {
    const release = vi.fn();
    const adapter: HonuaExportAdapter = {
      id: "print-with-resource",
      describeCapabilities: () => ({ adapterId: "print-with-resource", kinds: ["print"], cancellable: false }),
      // A real print adapter injects a print stylesheet and removes it on release.
      print: () => ({ mediaType: "application/vnd.honua.print-dialog", sideEffectOnly: true, release }),
    };
    const result = await runHonuaExport({ kind: "print", adapter, state: attributedState() });

    expect(result.status).toBe("ready");
    expect(result.sideEffectOnly).toBe(true);
    expect(result.ownership).toBe("caller-releases");
    expect(release).not.toHaveBeenCalled();

    await result.release();
    await result.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still reports none when a side-effect export holds nothing", async () => {
    const result = await runHonuaExport({
      kind: "print",
      adapter: createBrowserPrintExportAdapter({ print: () => {} }),
      state: attributedState(),
    });
    expect(result.ownership).toBe("none");
  });
});

describe("finding 6: a malformed capability declaration is a structured result, not a TypeError", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object with no kinds array", { adapterId: "malformed", cancellable: false }],
    ["kinds as a string", { adapterId: "malformed", kinds: "snapshot", cancellable: false }],
  ])("returns an error result when describeCapabilities() returns %s", async (_label, capabilities) => {
    const adapter = {
      id: "malformed",
      describeCapabilities: () => capabilities,
      snapshot: () => ({ mediaType: "image/png", bytes: new Uint8Array([1]) }),
    } as unknown as HonuaExportAdapter;

    // The guarantee under test: this resolves, never rejects.
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: attributedState() });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
    expect(result.error?.sdkCode).toBe("app.export-failed");
    expect(result.message).toContain("malformed capability declaration");
    // The always-callable release contract still holds.
    await expect(result.release()).resolves.toBeUndefined();
  });

  it("still reports a throwing describeCapabilities() as a structured result", async () => {
    const adapter = {
      id: "throwing-capabilities",
      describeCapabilities: () => {
        throw new Error("boom");
      },
    } as unknown as HonuaExportAdapter;
    const result = await runHonuaExport({ kind: "state", adapter, state: attributedState() });
    expect(result.status).toBe("error");
    expect(result.message).toContain("failed to describe its capabilities");
  });
});
