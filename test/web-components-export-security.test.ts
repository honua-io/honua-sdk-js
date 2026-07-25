import { describe, expect, it, vi } from "vitest";

import type { HonuaMapPackage } from "../src/runtime/index.js";
import {
  HONUA_EXPORT_KINDS,
  HONUA_EXPORT_STATE_SCHEMA,
  type HonuaExportAdapter,
  type HonuaExportPayload,
  HonuaExportSafetyError,
  assertHonuaExportProvenanceComplete,
  assertHonuaExportReady,
  buildHonuaExportProvenance,
  containsCredentialMaterial,
  createBrowserPrintExportAdapter,
  createHonuaExportAdapter,
  projectExportEndpoint,
  redactHonuaExportText,
  runHonuaExport,
  sanitizeHonuaExportFilename,
  sanitizeHonuaExportHeaders,
  sanitizeHonuaExportState,
} from "../src/web-components/index.js";
import type { HonuaWebComponentState } from "../src/web-components/types.js";

/**
 * Secure export (issue #683, REQ-001/REQ-002/REQ-003).
 *
 * The load-bearing claims proved here:
 *   - snapshot and sanitized-state export succeed through an explicit adapter
 *     and fail closed (no bytes, a registered capability error) without one;
 *   - credentials cannot reach exported bytes, serialized state, the
 *     `honua-export` event detail, a log line, or a download filename;
 *   - required attribution/licence provenance cannot be dropped;
 *   - ownership, cancellation, and error reporting behave as documented.
 *
 * Deliberately runs in the default Node environment: none of this needs a DOM,
 * and keeping it DOM-free proves the export pipeline is usable from a worker or
 * a server-side render pass.
 */

/** Every credential shape a real map app leaks through, in one place. */
// The Stripe-shaped token is assembled at runtime so GitHub push protection
// does not match the literal; the joined value is what the detector must catch.
const STRIPE_SHAPED_TOKEN = ["sk", "live", "abcdefghijklmnop1234567890"].join("_");
const SECRETS = {
  bearer: `Bearer ${STRIPE_SHAPED_TOKEN}`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  esriToken: "https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0?token=AAPK1234567890abcdefgh",
  azureSas: "https://tiles.blob.core.windows.net/basemap/{z}/{x}/{y}.pbf?sv=2021-08-06&sig=abc123DEFghi456JKLmno789",
  presigned:
    "https://bucket.s3.amazonaws.com/tiles.pmtiles?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=deadbeefcafebabe1234567890abcdef",
  apiKeyUrl: "https://api.maptiler.com/maps/streets/style.json?key=ABCdefGHIjklMNOpqrsT",
  userinfo: "https://admin:hunter2@internal.example.com/tiles/{z}/{x}/{y}.png",
} as const;

function mapPackageWithSecrets(): HonuaMapPackage {
  return {
    mapPackageId: "incident-response",
    format: "honua_map_package.v1",
    license: "CC-BY 4.0 — Example Data Cooperative",
    sourceBindings: [
      {
        sourceId: "roads",
        protocol: "geoservices_feature_service",
        locator: { url: SECRETS.esriToken, layerId: 0 },
        attribution: "© Example DOT",
        metadata: { "x-api-key": "ABCdefGHIjklMNOpqrsT", region: "us-west" },
      },
      {
        sourceId: "basemap",
        protocol: "vector_tile",
        locator: { url: SECRETS.azureSas },
        attribution: "© Example Basemap",
      },
      {
        sourceId: "classified",
        protocol: "geoservices_map_service",
        locator: { url: SECRETS.presigned },
        metadata: { "honua:exportable": "false" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {
        satellite: { type: "raster", tiles: [SECRETS.apiKeyUrl], attribution: "© Example Imagery" },
      },
      layers: [],
    } as unknown as HonuaMapPackage["mapSpec"],
  };
}

function stateWithSecrets(): HonuaWebComponentState {
  return {
    packageId: "incident-response",
    status: "ready",
    mapPackage: mapPackageWithSecrets(),
    layers: [
      { id: "roads-line", title: "Roads", sourceId: "roads", visible: true, opacity: 0.9 },
      { id: "basemap-raster", title: "Basemap", sourceId: "basemap", visible: true },
      { id: "classified-fill", title: "Restricted parcels", sourceId: "classified", visible: true },
      {
        id: "annotated",
        title: "Annotations",
        visible: false,
        metadata: { refreshToken: SECRETS.jwt },
      },
    ],
    legend: [{ id: "roads", label: "Roads", color: "#ff0000", iconUrl: SECRETS.apiKeyUrl, layerId: "roads-line" }],
    viewport: { center: [-157.85, 21.3], zoom: 12 },
    featuresBySource: {},
    featureStates: [],
    filters: {
      roads: { sourceId: "roads", text: "arterial", expression: "class = 'arterial'" },
      classified: { sourceId: "classified", text: "all" },
    },
    selection: {
      sourceId: "roads",
      featureId: 42,
      feature: { id: 42, sourceId: "roads", attributes: { ssn: "000-00-0000" } },
    },
    refreshedAt: "2026-07-01T12:00:00.000Z",
    stale: false,
  };
}

/** Serializes anything the export surfaced so a single scan covers it all. */
function allSurfacedText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? [...item] : item)) ?? "";
}

describe("export redaction primitives (REQ-002)", () => {
  it("redacts every credential shape a map app leaks through", () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(containsCredentialMaterial(secret), `${name} was not recognized as credential material`).toBe(true);
      const redacted = redactHonuaExportText(secret);
      expect(redacted, name).not.toContain(STRIPE_SHAPED_TOKEN);
      expect(redacted, name).not.toContain("AAPK1234567890abcdefgh");
      expect(redacted, name).not.toContain("abc123DEFghi456JKLmno789");
      expect(redacted, name).not.toContain("deadbeefcafebabe1234567890abcdef");
    }
  });

  it("sees through percent-encoding rather than treating it as opaque", () => {
    const encoded = `Authorization%3A%20Bearer%20${"a".repeat(48)}`;
    expect(containsCredentialMaterial(encoded)).toBe(true);
    expect(redactHonuaExportText(encoded)).not.toContain("a".repeat(48));
  });

  it("leaves ordinary attribution text untouched", () => {
    for (const safe of ["© OpenStreetMap contributors", "Roads (2026 refresh)", "1:24,000", "CC-BY 4.0"]) {
      expect(containsCredentialMaterial(safe), safe).toBe(false);
      expect(redactHonuaExportText(safe)).toBe(safe);
    }
  });

  it("reduces every endpoint to origin+path and reports why", () => {
    const esri = projectExportEndpoint(SECRETS.esriToken);
    expect(esri.endpoint).toBe("https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0");
    expect(esri.reason).toBe("signed-url");

    const sas = projectExportEndpoint(SECRETS.azureSas);
    expect(sas.endpoint).not.toContain("sig=");
    expect(sas.reason).toBe("signed-url");

    // Embedded userinfo yields nothing at all — there is no safe subset.
    expect(projectExportEndpoint(SECRETS.userinfo).endpoint).toBeUndefined();
    // Nor do non-HTTP schemes, which can inline an entire credentialed payload.
    expect(projectExportEndpoint("data:application/json;base64,eyJ0b2tlbiI6ImFiYyJ9").endpoint).toBeUndefined();
    expect(projectExportEndpoint("blob:https://example.com/1234").endpoint).toBeUndefined();
  });

  it("drops every non-allowlisted header, and any allowlisted one carrying a token", () => {
    const { headers, redactions } = sanitizeHonuaExportHeaders({
      Authorization: SECRETS.bearer,
      Cookie: "session=abc123",
      "X-API-Key": "ABCdefGHIjklMNOpqrsT",
      "X-Scope": "read:all",
      Accept: "application/json",
      "Accept-Language": "en-US",
    });
    expect(Object.keys(headers).sort()).toEqual(["accept", "accept-language"]);
    expect(allSurfacedText(headers)).not.toContain("abc123");
    expect(redactions.map((entry) => entry.path).sort()).toEqual([
      "headers[authorization]",
      "headers[cookie]",
      "headers[x-api-key]",
      "headers[x-scope]",
    ]);
    expect(redactions.find((entry) => entry.path === "headers[x-scope]")?.reason).toBe("sensitive-key");
  });
});

describe("filenames cannot disclose a credential (REQ-002)", () => {
  it("discards a credential-bearing title wholesale rather than partially redacting it", () => {
    const filename = sanitizeHonuaExportFilename({ title: `map ${SECRETS.esriToken}`, mediaType: "image/png" });
    expect(filename).toBe("honua-export.png");
    expect(filename).not.toContain("AAPK");
    expect(filename).not.toContain("REDACTED");
  });

  it("keeps a safe title, slugified and extension-stamped", () => {
    expect(sanitizeHonuaExportFilename({ title: "Incident Response / Oahu", mediaType: "image/png" })).toBe(
      "honua-Incident-Response-Oahu.png",
    );
    expect(sanitizeHonuaExportFilename({ title: "state", mediaType: "application/json" })).toBe("honua-state.json");
  });

  it("never emits a path separator, a leading dot, or an unbounded name", () => {
    expect(sanitizeHonuaExportFilename({ title: "../../etc/passwd" })).not.toContain("/");
    expect(sanitizeHonuaExportFilename({ title: "../../etc/passwd" }).startsWith(".")).toBe(false);
    expect(sanitizeHonuaExportFilename({ title: "..\\..\\windows\\system32" })).not.toContain("\\");
    expect(sanitizeHonuaExportFilename({ title: "x".repeat(500) }).length).toBeLessThanOrEqual(96);
    // Whitespace, control characters, and shell-quoting characters are all
    // collapsed away: the result is confined to the safe alphabet.
    expect(sanitizeHonuaExportFilename({ title: "a b\nc\td e" })).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(sanitizeHonuaExportFilename({ title: 'a";rm -rf /' })).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("sanitized state projection (REQ-002)", () => {
  it("carries presentation state and no credential material", () => {
    const { state, redactions } = sanitizeHonuaExportState(stateWithSecrets());
    const serialized = JSON.stringify(state);

    expect(state.schema).toBe(HONUA_EXPORT_STATE_SCHEMA);
    expect(state.packageId).toBe("incident-response");
    expect(state.viewport).toEqual({ center: [-157.85, 21.3], zoom: 12 });
    expect(state.layers.map((layer) => layer.id)).toContain("roads-line");
    expect(state.refreshedAt).toBe("2026-07-01T12:00:00.000Z");

    for (const secret of Object.values(SECRETS)) {
      expect(serialized, secret).not.toContain(secret);
    }
    for (const fragment of [
      "token=",
      "sig=",
      "X-Amz-Signature",
      "key=ABCdefGHIjklMNOpqrsT",
      "hunter2",
      "eyJhbGciOiJIUzI1NiJ9",
      "000-00-0000",
    ]) {
      expect(serialized, fragment).not.toContain(fragment);
    }
    expect(containsCredentialMaterial(serialized)).toBe(false);
    expect(redactions.length).toBeGreaterThan(0);
  });

  it("keeps source identity and attribution while dropping the locator query and metadata bag", () => {
    const { state } = sanitizeHonuaExportState(stateWithSecrets());
    const roads = state.sources.find((source) => source.sourceId === "roads");
    expect(roads?.endpoint).toBe("https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0");
    expect(roads?.attribution).toBe("© Example DOT");
    expect(roads).not.toHaveProperty("metadata");
    expect(JSON.stringify(roads)).not.toContain("us-west");
  });

  it("omits a source the plan marks non-exportable, and every layer and filter bound to it", () => {
    const { state, redactions } = sanitizeHonuaExportState(stateWithSecrets());
    const classified = state.sources.find((source) => source.sourceId === "classified");
    expect(classified).toEqual({ sourceId: "classified", omitted: true });
    expect(state.layers.map((layer) => layer.id)).not.toContain("classified-fill");
    expect(state.filters.map((filter) => filter.sourceId)).not.toContain("classified");
    expect(redactions.filter((entry) => entry.reason === "non-exportable-source").length).toBeGreaterThanOrEqual(3);
  });

  it("honours a caller-supplied non-exportable source list too", () => {
    const { state } = sanitizeHonuaExportState(stateWithSecrets(), { nonExportableSourceIds: ["roads"] });
    expect(state.sources.find((source) => source.sourceId === "roads")).toEqual({
      sourceId: "roads",
      omitted: true,
    });
    expect(state.layers.map((layer) => layer.id)).not.toContain("roads-line");
  });

  it("never carries selected-feature attributes, only selection identity", () => {
    const { state, redactions } = sanitizeHonuaExportState(stateWithSecrets());
    expect(state.selection).toEqual({ sourceId: "roads", featureId: 42 });
    expect(redactions.some((entry) => entry.path === "selection.feature")).toBe(true);
  });

  it("drops legend icon URLs, which are routinely signed service URLs", () => {
    const { state, redactions } = sanitizeHonuaExportState(stateWithSecrets());
    expect(state.legend[0]).not.toHaveProperty("iconUrl");
    expect(redactions.some((entry) => entry.path === "legend[0].iconUrl" && entry.reason === "signed-url")).toBe(true);
  });

  it("excludes fields nobody allowlisted, so upstream state growth cannot widen an export", () => {
    const state = stateWithSecrets() as HonuaWebComponentState & { credentialStore?: unknown };
    state.credentialStore = { refreshToken: SECRETS.jwt };
    const { state: sanitized } = sanitizeHonuaExportState(state);
    expect(sanitized).not.toHaveProperty("credentialStore");
    expect(JSON.stringify(sanitized)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("fail-closed export without an adapter (REQ-001)", () => {
  it.each(["snapshot", "state"] as const)("refuses %s and produces no bytes", async (kind) => {
    const result = await runHonuaExport({ kind, state: stateWithSecrets() });
    expect(result.status).toBe("unsupported");
    expect(result.bytes).toBeUndefined();
    expect(result.text).toBeUndefined();
    expect(result.filename).toBeUndefined();
    expect(result.adapterId).toBeUndefined();
    expect(result.error?.sdkCode).toBe("core.capability-not-supported");
    expect(result.message).toContain("requires an explicit export adapter");
    expect(() => assertHonuaExportReady(result)).toThrow(/not supported/i);
  });

  it("refuses a kind the adapter does not declare, without calling it", async () => {
    const snapshot = vi.fn();
    const adapter: HonuaExportAdapter = {
      id: "state-only",
      describeCapabilities: () => ({ adapterId: "state-only", kinds: ["state"], cancellable: false }),
      snapshot,
      exportState: () => ({ mediaType: "application/json", text: "{}" }),
    };
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("unsupported");
    expect(result.message).toContain('does not declare the "snapshot" export kind');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("reports a declared-but-unimplemented kind instead of silently succeeding", async () => {
    const adapter: HonuaExportAdapter = {
      id: "liar",
      describeCapabilities: () => ({ adapterId: "liar", kinds: ["snapshot"], cancellable: false }),
    };
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("unsupported");
    expect(result.message).toContain("does not implement snapshot()");
    expect(result.error?.sdkCode).toBe("core.capability-not-supported");
  });

  it("covers every declared export kind", () => {
    expect([...HONUA_EXPORT_KINDS]).toEqual(["print", "snapshot", "state"]);
  });
});

describe("export through an explicit adapter (REQ-001)", () => {
  /** A canvas that behaves like a MapLibre canvas created with preserveDrawingBuffer. */
  function fakeCanvas(): { toDataURL: () => string } {
    // 1x1 transparent PNG.
    return {
      toDataURL: () =>
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFVQwPuAAAAAElFTkSuQmCC",
    };
  }

  it("produces a snapshot artifact with a safe filename and full provenance", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", snapshot: { getCanvas: fakeCanvas } });
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter,
      state: stateWithSecrets(),
      title: "Incident Response",
      exportedAt: "2026-07-25T00:00:00.000Z",
    });

    expect(result.status).toBe("ready");
    expect(result.adapterId).toBe("test-app");
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes?.byteLength).toBeGreaterThan(0);
    // PNG magic number — real bytes, not a blank placeholder.
    expect([...(result.bytes ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.filename).toBe("honua-Incident-Response.png");
    expect(result.provenance.attribution).toEqual(
      expect.arrayContaining(["© Example DOT", "© Example Basemap", "© Example Imagery"]),
    );
    expect(result.provenance.licenseNotices).toEqual(["CC-BY 4.0 — Example Data Cooperative"]);
    expect(result.provenance.scaleLabel).toMatch(/^1:[\d,]+$/);
    expect(result.provenance.exportedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(result.provenance.dataFreshnessAt).toBe("2026-07-01T12:00:00.000Z");
    expect(result.provenance.fidelityWarnings.join(" ")).toContain("non-exportable");
    expect(containsCredentialMaterial(allSurfacedText(result))).toBe(false);
  });

  it("produces a sanitized state artifact whose bytes contain no credential", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", state: true });
    const result = await runHonuaExport({
      kind: "state",
      adapter,
      state: stateWithSecrets(),
      title: "Incident Response",
    });

    expect(result.status).toBe("ready");
    expect(result.mediaType).toBe("application/json");
    expect(result.filename).toBe("honua-Incident-Response.json");
    const parsed = JSON.parse(result.text ?? "{}");
    expect(parsed.schema).toBe(HONUA_EXPORT_STATE_SCHEMA);
    expect(parsed.provenance.attribution).toContain("© Example DOT");
    for (const secret of Object.values(SECRETS)) {
      expect(result.text, secret).not.toContain(secret);
    }
    expect(containsCredentialMaterial(result.text ?? "")).toBe(false);
  });

  it("never hands the adapter raw state — the sanitized document is all it sees", async () => {
    const seen: unknown[] = [];
    const adapter = createHonuaExportAdapter({
      id: "inspector",
      state: (context) => {
        seen.push(context);
        return { mediaType: "application/json", text: JSON.stringify(context.state) };
      },
    });
    await runHonuaExport({ kind: "state", adapter, state: stateWithSecrets() });
    const serialized = allSurfacedText(seen);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized, secret).not.toContain(secret);
    }
    expect(containsCredentialMaterial(serialized)).toBe(false);
    // The adapter also gets no controller, client, or credential handle.
    expect(Object.keys(seen[0] as object).sort()).toEqual([
      "kind",
      "mediaType",
      "provenance",
      "signal",
      "state",
      "title",
    ]);
  });

  it("prints through the built-in browser adapter as a side effect with no payload", async () => {
    const print = vi.fn();
    const result = await runHonuaExport({
      kind: "print",
      adapter: createBrowserPrintExportAdapter({ print }),
      state: stateWithSecrets(),
    });
    expect(print).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ready");
    expect(result.sideEffectOnly).toBe(true);
    expect(result.bytes).toBeUndefined();
    expect(result.provenance.fidelityWarnings.join(" ")).toContain("on-screen layout");
  });

  it("reports the browser print adapter as unavailable with no window", async () => {
    const adapter = createBrowserPrintExportAdapter(undefined);
    expect(adapter.describeCapabilities().kinds).toEqual([]);
    const result = await runHonuaExport({ kind: "print", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("unsupported");
  });

  it("fails closed when the renderer canvas is not readable", async () => {
    const adapter = createHonuaExportAdapter({ id: "blank", snapshot: { getCanvas: () => undefined } });
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
    expect(result.message).toContain("preserveDrawingBuffer");
  });
});

describe("a hostile or buggy adapter cannot leak (REQ-002)", () => {
  function adapterReturning(payload: HonuaExportPayload): HonuaExportAdapter {
    return {
      id: "hostile",
      describeCapabilities: () => ({ adapterId: "hostile", kinds: ["state", "snapshot"], cancellable: false }),
      exportState: () => payload,
      snapshot: () => payload,
    };
  }

  it("refuses text bytes that carry a credential, and releases the adapter's resources", async () => {
    const release = vi.fn();
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterReturning({
        mediaType: "application/json",
        text: JSON.stringify({ tileUrl: SECRETS.azureSas }),
        release,
      }),
      state: stateWithSecrets(),
    });
    expect(result.status).toBe("error");
    expect(result.text).toBeUndefined();
    expect(result.error).toBeInstanceOf(HonuaExportSafetyError);
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.ownership).toBe("released");
  });

  it("refuses a binary payload that decodes to credential-bearing text", async () => {
    const bytes = new TextEncoder().encode(`<svg><image href="${SECRETS.presigned}"/></svg>`);
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter: adapterReturning({ mediaType: "image/svg+xml", bytes }),
      state: stateWithSecrets(),
    });
    expect(result.status).toBe("error");
    expect(result.bytes).toBeUndefined();
  });

  it("redacts an adapter exception message before it reaches the result or a log", async () => {
    const adapter: HonuaExportAdapter = {
      id: "throwing",
      describeCapabilities: () => ({ adapterId: "throwing", kinds: ["snapshot"], cancellable: false }),
      snapshot: () => {
        throw new Error(`tile fetch failed for ${SECRETS.azureSas}`);
      },
    };
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("error");
    expect(result.message).not.toContain("sig=");
    expect(containsCredentialMaterial(allSurfacedText({ message: result.message }))).toBe(false);
    // The structured error is the SDK envelope, whose own toJSON omits messages.
    expect(result.error?.sdkCode).toBe("app.export-failed");
    expect(JSON.stringify(result.error?.toJSON())).not.toContain("sig=");
  });

  it("redacts an adapter's fidelity warnings", async () => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterReturning({
        mediaType: "application/json",
        text: "{}",
        fidelityWarnings: [`could not rasterize ${SECRETS.apiKeyUrl}`],
      }),
      state: stateWithSecrets(),
    });
    expect(result.status).toBe("ready");
    expect(allSurfacedText(result.provenance)).not.toContain("key=ABCdefGHIjklMNOpqrsT");
  });

  it("refuses a payload with neither bytes nor text, and one with no media type", async () => {
    const noBody = await runHonuaExport({
      kind: "state",
      adapter: adapterReturning({ mediaType: "application/json" }),
      state: stateWithSecrets(),
    });
    expect(noBody.status).toBe("error");

    const noMediaType = await runHonuaExport({
      kind: "state",
      adapter: adapterReturning({ mediaType: "", text: "{}" }),
      state: stateWithSecrets(),
    });
    expect(noMediaType.status).toBe("error");
  });

  it("discards a credential-bearing filename hint", async () => {
    const result = await runHonuaExport({
      kind: "state",
      adapter: adapterReturning({
        mediaType: "application/json",
        text: "{}",
        filenameHint: `export-${SECRETS.jwt}`,
      }),
      state: stateWithSecrets(),
    });
    expect(result.status).toBe("ready");
    expect(result.filename).toBe("honua-export.json");
  });
});

describe("ownership and cancellation (REQ-001)", () => {
  const payload: HonuaExportPayload = { mediaType: "application/json", text: "{}" };

  it("always provides an idempotent release, and does not pre-release a successful export", async () => {
    const release = vi.fn();
    const adapter: HonuaExportAdapter = {
      id: "owner",
      describeCapabilities: () => ({ adapterId: "owner", kinds: ["state"], cancellable: true }),
      exportState: () => ({ ...payload, release }),
    };
    const result = await runHonuaExport({ kind: "state", adapter, state: stateWithSecrets() });
    expect(result.ownership).toBe("caller-releases");
    expect(release).not.toHaveBeenCalled();
    await result.release();
    await result.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports ownership 'none' and a callable release when the adapter holds nothing", async () => {
    const adapter: HonuaExportAdapter = {
      id: "stateless",
      describeCapabilities: () => ({ adapterId: "stateless", kinds: ["state"], cancellable: true }),
      exportState: () => payload,
    };
    const result = await runHonuaExport({ kind: "state", adapter, state: stateWithSecrets() });
    expect(result.ownership).toBe("none");
    await expect(result.release()).resolves.toBeUndefined();
  });

  it("hands back bytes the caller owns, unaffected by the adapter reusing its buffer", async () => {
    const shared = new Uint8Array([1, 2, 3, 4]);
    const adapter: HonuaExportAdapter = {
      id: "pooled",
      describeCapabilities: () => ({ adapterId: "pooled", kinds: ["snapshot"], cancellable: false }),
      snapshot: () => ({ mediaType: "image/png", bytes: shared }),
    };
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    shared.fill(0);
    expect([...(result.bytes ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it("refuses to run at all when the signal is already aborted", async () => {
    const exportState = vi.fn();
    const adapter: HonuaExportAdapter = {
      id: "cancellable",
      describeCapabilities: () => ({ adapterId: "cancellable", kinds: ["state"], cancellable: true }),
      exportState,
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runHonuaExport({
      kind: "state",
      adapter,
      state: stateWithSecrets(),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(exportState).not.toHaveBeenCalled();
    expect(result.error?.sdkCode).toBe("core.cancelled");
  });

  it("releases and reports cancellation when the signal fires while the adapter works", async () => {
    const release = vi.fn();
    const controller = new AbortController();
    const adapter: HonuaExportAdapter = {
      id: "slow",
      describeCapabilities: () => ({ adapterId: "slow", kinds: ["snapshot"], cancellable: true }),
      snapshot: async (context) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort();
        return { mediaType: "image/png", bytes: new Uint8Array([1]), release };
      },
    };
    const result = await runHonuaExport({
      kind: "snapshot",
      adapter,
      state: stateWithSecrets(),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.bytes).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("treats an adapter's own AbortError as cancellation, not a failure", async () => {
    const adapter: HonuaExportAdapter = {
      id: "aborter",
      describeCapabilities: () => ({ adapterId: "aborter", kinds: ["snapshot"], cancellable: true }),
      snapshot: () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const result = await runHonuaExport({ kind: "snapshot", adapter, state: stateWithSecrets() });
    expect(result.status).toBe("cancelled");
  });
});

describe("provenance cannot be dropped (REQ-003)", () => {
  it("unions source-declared and plan-required attribution", () => {
    const state = stateWithSecrets();
    const { state: sanitized } = sanitizeHonuaExportState(state);
    const provenance = buildHonuaExportProvenance(state, sanitized, {
      requiredAttribution: ["© Accepted Plan Source"],
      requiredLicenseNotices: ["ODbL 1.0"],
    });
    expect(provenance.attribution).toEqual(expect.arrayContaining(["© Example DOT", "© Accepted Plan Source"]));
    expect(provenance.licenseNotices).toEqual(
      expect.arrayContaining(["CC-BY 4.0 — Example Data Cooperative", "ODbL 1.0"]),
    );
  });

  it("fails closed when a required attribution string is missing", () => {
    expect(() =>
      assertHonuaExportProvenanceComplete(
        {
          exportedAt: "2026-07-25T00:00:00.000Z",
          attribution: [],
          licenseNotices: [],
          fidelityWarnings: [],
          generator: "test",
        },
        { attribution: ["© Example DOT"], licenseNotices: [] },
      ),
    ).toThrow(HonuaExportSafetyError);
  });

  it("carries the same scale label the map status readout shows", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", state: true });
    const result = await runHonuaExport({ kind: "state", adapter, state: stateWithSecrets() });
    // zoom 12 at latitude 21.3 — the shared approximateHonuaScaleLabel implementation.
    expect(result.provenance.scaleLabel).toBe("1:134,581");
  });

  it("admits omitted non-exportable sources as a fidelity loss rather than shipping silently", async () => {
    const adapter = createHonuaExportAdapter({ id: "test-app", state: true });
    const result = await runHonuaExport({ kind: "state", adapter, state: stateWithSecrets() });
    expect(result.provenance.fidelityWarnings.join(" ")).toContain("classified");
  });
});
