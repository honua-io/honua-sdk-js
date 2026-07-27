/**
 * The Honua component kit's **export-adapter contract** (issue #683, parent
 * epic #678; REQ-001/REQ-002/REQ-003).
 *
 * ## Why an adapter at all
 *
 * `<honua-print-export>` has always offered three actions — print layout,
 * renderer snapshot, sanitized state JSON — but only browser print was ever
 * implemented. The other two were *correctly* reported as unsupported rather
 * than being faked, because producing them safely needs something the
 * component kit does not have and must not guess at:
 *
 * - A **renderer** it is allowed to read pixels from. `canvas.toDataURL()` on a
 *   WebGL map silently returns a blank image unless the map was created with
 *   `preserveDrawingBuffer: true`, and it throws on a canvas tainted by
 *   cross-origin tiles. Only the application that constructed the map knows
 *   which of those is true, and only it can decide whether reading those
 *   pixels is authorized.
 * - An **authorization boundary**. A map's live state transitively references
 *   the credentials that made it work: signed tile URLs, `Authorization`
 *   headers, SAS query strings, OAuth scope detail. Serializing "the current
 *   state" naively hands all of that to whoever receives the file.
 *
 * So export is modelled as an explicit, injected capability. There is no
 * ambient fallback that "does its best": with no adapter, snapshot and state
 * export **fail closed** with {@link HonuaCapabilityNotSupportedError} and
 * produce no bytes at all. That is the whole point — a missing adapter must
 * never degrade into a silent, partially-credentialed artifact.
 *
 * ## The four things the contract makes explicit (REQ-001)
 *
 * 1. **Capability** — {@link HonuaExportAdapter.describeCapabilities} declares
 *    exactly which kinds the adapter implements. A kind it does not declare is
 *    refused before the adapter is called; a kind it declares but does not
 *    implement is a *reported* contract violation, never a silent no-op.
 * 2. **Ownership** — every result carries {@link HonuaExportResult.ownership}
 *    and an always-present {@link HonuaExportResult.release}. `bytes` handed to
 *    the caller are the caller's to keep and remain valid after `release()`;
 *    `release()` frees only adapter-held resources (object URLs, offscreen
 *    canvases, server-side render jobs). Callers can therefore always call it
 *    exactly once, unconditionally, in a `finally`.
 * 3. **Cancellation** — an {@link AbortSignal} is checked before the adapter
 *    runs, forwarded to it, and re-checked after it returns; a cancelled export
 *    releases whatever the adapter produced and yields `status: "cancelled"`
 *    with no bytes.
 * 4. **Error reporting** — the runner never throws. It returns a discriminated
 *    {@link HonuaExportResult} whose `status` is one of
 *    `ready`/`unsupported`/`cancelled`/`error`, with a redacted `message` and
 *    the structured `error` for programmatic handling. Elements can render the
 *    envelope directly; callers who prefer exceptions use
 *    {@link assertHonuaExportReady}.
 *
 * ## Redaction is not the adapter's job (REQ-002)
 *
 * The runner sanitizes state **before** the adapter is invoked, so an adapter
 * — including a third-party or server-side one — never receives credential
 * material in the first place. It then re-scans everything the adapter returned
 * (bytes, text, filename hint, fidelity warnings) and refuses to emit an
 * artifact that fails the scan. Both layers live in
 * {@link "./export-redaction.js"}; see that module for the two-layer model.
 *
 * ## Provenance travels with the artifact (REQ-003)
 *
 * Attribution, license notices, scale, export timestamp, data-freshness, and
 * fidelity warnings are assembled by the runner from the map package and
 * controller state, handed to the adapter, and echoed on the result. Where a
 * source declares attribution, the export **cannot** drop it: an artifact
 * missing required attribution fails closed exactly like a credential leak,
 * because shipping an unattributed map is a licence violation, not a cosmetic
 * defect.
 *
 * ## Bundle posture (NFR-001)
 *
 * This module and its redaction sibling import nothing but the SDK's own error
 * base and types. No renderer, PDF writer, image encoder, localization
 * framework, or test-only peer is referenced, statically or dynamically —
 * every one of those lives on the application side of the adapter seam. The
 * built-in adapters here are thin structural shims over objects the caller
 * already owns.
 *
 * @module
 */

import { HonuaSdkError } from "../core/error-envelope.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaMapPackage } from "../runtime/index.js";
import {
  type HonuaExportRedaction,
  HonuaExportSafetyError,
  type HonuaSanitizedExportState,
  assertCredentialFreeExportBytes,
  assertCredentialFreeExportText,
  redactHonuaExportText,
  sanitizeHonuaExportFilename,
  sanitizeHonuaExportState,
} from "./export-redaction.js";
import type { HonuaViewportState, HonuaWebComponentState } from "./types.js";

/** Protocol label used in capability errors raised by the export pipeline. */
const EXPORT_PROTOCOL = "honua-app-platform-export";

/** What an export produces. */
export type HonuaExportKind =
  /** A print layout (browser print dialog, or an adapter-rendered paginated document). */
  | "print"
  /** A raster/vector image of the current renderer view. */
  | "snapshot"
  /** A sanitized, credential-free JSON document describing the current view state. */
  | "state";

/** Every export kind, in a stable order. */
export const HONUA_EXPORT_KINDS: readonly HonuaExportKind[] = Object.freeze(["print", "snapshot", "state"] as const);

/** Terminal status of one export attempt. */
export type HonuaExportStatus =
  /** An artifact was produced and passed every safety assertion. */
  | "ready"
  /** No adapter, or the adapter does not implement this kind. No bytes were produced. */
  | "unsupported"
  /** The caller's `AbortSignal` fired. Adapter-held resources were released. */
  | "cancelled"
  /** The adapter threw, returned an unusable payload, or produced an unsafe artifact. */
  | "error";

/** Who is responsible for releasing adapter-held resources. */
export type HonuaExportOwnership =
  /** Nothing to release; `release()` is a no-op. */
  | "none"
  /** The caller must call `release()` when finished; the runner has not called it. */
  | "caller-releases"
  /** The runner already released everything (cancelled/failed export). */
  | "released";

/**
 * Attribution and fidelity metadata that must survive into every artifact
 * (REQ-003). Assembled by {@link buildHonuaExportProvenance}.
 */
export interface HonuaExportProvenance {
  /** ISO-8601 instant the export was produced. */
  readonly exportedAt: string;
  /** Attribution strings required by the bound sources or the accepted plan. Never dropped. */
  readonly attribution: readonly string[];
  /** Licence notices required by the bound sources or the accepted plan. Never dropped. */
  readonly licenseNotices: readonly string[];
  /** Human-readable approximate scale, e.g. `"1:24,000"`. */
  readonly scaleLabel?: string;
  /** ISO-8601 instant the underlying data was last refreshed, when known. */
  readonly dataFreshnessAt?: string;
  /** `true` when the exported view is known to be showing stale data. */
  readonly stale?: boolean;
  /**
   * Honest statements about what the artifact does *not* faithfully reproduce
   * (unsupported layer types, omitted non-exportable sources, rasterized
   * vector text, ...). Adapters may append their own.
   */
  readonly fidelityWarnings: readonly string[];
  /** Map-package id the export came from, when known. */
  readonly packageId?: string;
  /** The producing component kit, for artifact traceability. */
  readonly generator: string;
}

/** Declares what an adapter can actually do. */
export interface HonuaExportCapabilities {
  /** Stable adapter id, surfaced on results and in diagnostics. */
  readonly adapterId: string;
  /** Kinds this adapter implements. A kind absent here is refused before the adapter runs. */
  readonly kinds: readonly HonuaExportKind[];
  /** Whether the adapter honours an `AbortSignal` mid-flight. Purely informational: the runner enforces cancellation either way. */
  readonly cancellable: boolean;
  /** Media types the adapter can emit for `snapshot`, most preferred first. */
  readonly snapshotMediaTypes?: readonly string[];
  /** Optional pixel ceiling the adapter will not exceed, for callers sizing a request. */
  readonly maxSnapshotPixels?: number;
}

/**
 * Everything an adapter is given. Note what is *absent*: no controller, no
 * client, no credential store, no raw state. An adapter cannot reach
 * credential material through this object even if it tries.
 */
export interface HonuaExportContext {
  readonly kind: HonuaExportKind;
  /** Caller-supplied, already-redacted title. */
  readonly title: string | undefined;
  /** Provenance the adapter must stamp into the artifact where the format allows it. */
  readonly provenance: HonuaExportProvenance;
  /** Credential-free state document. Always present for `state`; supplied for the others as layout input. */
  readonly state: HonuaSanitizedExportState;
  /** Cancellation signal. Adapters that do long work should honour it. */
  readonly signal: AbortSignal | undefined;
  /** Requested media type, when the caller expressed a preference. */
  readonly mediaType: string | undefined;
}

/** What an adapter returns for a successful export. */
export interface HonuaExportPayload {
  /** Media type of `bytes`/`text`. */
  readonly mediaType: string;
  /** Binary artifact. Mutually exclusive with `text` in practice; `bytes` wins if both are set. */
  readonly bytes?: Uint8Array;
  /** Text artifact (JSON, SVG, HTML). */
  readonly text?: string;
  /** Suggested filename stem. Sanitized by the runner; a hint that looks credential-bearing is discarded. */
  readonly filenameHint?: string;
  /** Additional honest fidelity caveats, merged into the result's provenance. */
  readonly fidelityWarnings?: readonly string[];
  /**
   * Releases adapter-held resources. The runner always calls this exactly once
   * on a cancelled or failed export, and never calls it on a successful one —
   * a successful result hands the obligation to the caller via
   * {@link HonuaExportResult.release}.
   */
  readonly release?: () => void | Promise<void>;
  /**
   * `true` when this export completed as a side effect and carries no bytes —
   * the browser print dialog being the canonical case.
   */
  readonly sideEffectOnly?: boolean;
  /**
   * Whether the artifact's **bytes** carry the attribution and licence notices
   * the sources require (REQ-003) — a watermark composited into the image, a
   * PDF footer, a JSON provenance block.
   *
   * Defaults to `false`, which is the honest default: reading a WebGL canvas
   * captures the map's pixels and nothing else, because MapLibre renders its
   * attribution as DOM outside the canvas. An adapter that does not composite
   * attribution must not claim it did, so the runner adds an explicit fidelity
   * warning naming what the caller has to present alongside the artifact, and
   * {@link HonuaExportRequest.requireEmbeddedProvenance} turns that into a hard
   * failure for callers who cannot.
   */
  readonly provenanceEmbedded?: boolean;
}

/**
 * One export kind's implementation. Every method is optional; whichever kinds
 * {@link HonuaExportAdapter.describeCapabilities} declares must have the
 * matching method, and the runner reports a violation rather than silently
 * succeeding when it does not.
 */
export interface HonuaExportAdapter {
  /** Stable identifier, echoed on results. */
  readonly id: string;
  describeCapabilities(): HonuaExportCapabilities;
  print?(context: HonuaExportContext): HonuaExportPayload | Promise<HonuaExportPayload>;
  snapshot?(context: HonuaExportContext): HonuaExportPayload | Promise<HonuaExportPayload>;
  exportState?(context: HonuaExportContext): HonuaExportPayload | Promise<HonuaExportPayload>;
}

/** The outcome of one export attempt. Never thrown — always returned. */
export interface HonuaExportResult {
  readonly kind: HonuaExportKind;
  readonly status: HonuaExportStatus;
  /** Adapter that served the request, or `undefined` when none was available. */
  readonly adapterId: string | undefined;
  /** Credential-safe download filename. Present only on `ready`. */
  readonly filename?: string;
  readonly mediaType?: string;
  /** Caller-owned bytes. Remain valid after {@link release}. */
  readonly bytes?: Uint8Array;
  /** Caller-owned text. */
  readonly text?: string;
  /** `true` when the export completed as a side effect (browser print) and has no payload. */
  readonly sideEffectOnly?: boolean;
  readonly provenance: HonuaExportProvenance;
  /**
   * Whether the required attribution and licence notices are carried by the
   * artifact's own bytes (REQ-003). When `false`, `provenance` still names them
   * and `provenance.fidelityWarnings` says so explicitly — the caller is
   * responsible for presenting them wherever the artifact is published.
   * `undefined` only on results that produced no artifact.
   */
  readonly provenanceEmbedded?: boolean;
  /** Everything withheld while sanitizing state for this export. */
  readonly redactions: readonly HonuaExportRedaction[];
  readonly ownership: HonuaExportOwnership;
  /** Always defined; safe to call exactly once regardless of `status`. Idempotent. */
  readonly release: () => Promise<void>;
  /** Redacted, human-readable explanation. Safe to log, display, or put on an event. */
  readonly message?: string;
  /** Structured failure for programmatic handling. */
  readonly error?: HonuaSdkError;
}

export interface HonuaExportRequest<T = Record<string, unknown>> {
  readonly kind: HonuaExportKind;
  /** Adapter to serve the request. Omitting it is what makes an export fail closed. */
  readonly adapter?: HonuaExportAdapter | undefined;
  /** Live component state. Sanitized before the adapter sees any of it. */
  readonly state?: HonuaWebComponentState<T> | undefined;
  /** Untrusted title (map name, package id, user input). */
  readonly title?: string;
  readonly signal?: AbortSignal;
  readonly mediaType?: string;
  /** Sources the accepted plan marks non-exportable. See `SanitizeHonuaExportStateOptions`. */
  readonly nonExportableSourceIds?: readonly string[];
  /** Extra attribution required by the accepted plan beyond what the sources declare. */
  readonly requiredAttribution?: readonly string[];
  /** Licence notices required by the accepted plan. */
  readonly requiredLicenseNotices?: readonly string[];
  /**
   * Fail closed unless the adapter embeds the required attribution into the
   * artifact's own bytes (REQ-003). Off by default, because the common and
   * legitimate arrangement is for the application to present attribution
   * alongside the artifact — the result reports
   * {@link HonuaExportResult.provenanceEmbedded} and carries an explicit
   * fidelity warning either way. Set this when the artifact will travel on its
   * own, with no surrounding surface to carry the notice.
   */
  readonly requireEmbeddedProvenance?: boolean;
  /** Overrides the export timestamp. Tests pin it; production should not set it. */
  readonly exportedAt?: string;
}

/** Thrown by {@link assertHonuaExportReady} and used to wrap adapter faults. */
export class HonuaExportError extends HonuaSdkError {
  public readonly status: HonuaExportStatus;

  public constructor(status: Exclude<HonuaExportStatus, "ready">, message: string, options: { cause?: unknown } = {}) {
    super("app.export-failed", message, options);
    this.name = "HonuaExportError";
    this.status = status;
  }
}

// ── provenance ───────────────────────────────────────────────────────────

/** `1:24,000`-style approximate scale for a web-mercator viewport at 96 DPI. */
export function approximateHonuaScaleLabel(viewport: HonuaViewportState | undefined): string | undefined {
  const zoom = viewport?.zoom;
  if (!Number.isFinite(zoom)) return undefined;
  const latitude = viewport?.center?.[1] ?? 0;
  const metersPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** Number(zoom);
  const scale = Math.max(1, Math.round(metersPerPixel * 96 * 39.37));
  return `1:${scale.toLocaleString("en-US")}`;
}

/** Attribution strings a map package's own bindings and style sources declare. */
function collectDeclaredAttribution(mapPackage: HonuaMapPackage | undefined): string[] {
  const attribution = new Set<string>();
  for (const binding of mapPackage?.sourceBindings ?? []) {
    if (typeof binding.attribution === "string" && binding.attribution.trim().length > 0) {
      attribution.add(redactHonuaExportText(binding.attribution.trim()).slice(0, 512));
    }
  }
  const styleSources = mapPackage?.mapSpec?.sources;
  if (styleSources && typeof styleSources === "object") {
    for (const source of Object.values(styleSources as Record<string, unknown>)) {
      const value = (source as { attribution?: unknown } | null)?.attribution;
      if (typeof value === "string" && value.trim().length > 0) {
        attribution.add(redactHonuaExportText(value.trim()).slice(0, 512));
      }
    }
  }
  return [...attribution];
}

/** Licence notices declared on the map package (`license`, `licence`, or `metadata.license`). */
function collectDeclaredLicenseNotices(mapPackage: HonuaMapPackage | undefined): string[] {
  const notices = new Set<string>();
  const candidates: unknown[] = [
    mapPackage?.license,
    mapPackage?.licence,
    (mapPackage?.metadata as { license?: unknown } | undefined)?.license,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      notices.add(redactHonuaExportText(candidate.trim()).slice(0, 512));
    }
  }
  return [...notices];
}

export interface BuildHonuaExportProvenanceOptions {
  readonly requiredAttribution?: readonly string[];
  readonly requiredLicenseNotices?: readonly string[];
  readonly fidelityWarnings?: readonly string[];
  readonly exportedAt?: string;
}

/**
 * Assembles the provenance block for an export (REQ-003) from the map package
 * and controller state, unioned with anything the accepted plan additionally
 * requires. Every string is redacted, because attribution text is
 * caller-supplied and has appeared with a signed URL in it in the wild.
 */
export function buildHonuaExportProvenance<T>(
  state: HonuaWebComponentState<T> | undefined,
  sanitized: HonuaSanitizedExportState,
  options: BuildHonuaExportProvenanceOptions = {},
): HonuaExportProvenance {
  const attribution = new Set(collectDeclaredAttribution(state?.mapPackage));
  for (const entry of options.requiredAttribution ?? []) {
    const trimmed = redactHonuaExportText(entry.trim()).slice(0, 512);
    if (trimmed.length > 0) attribution.add(trimmed);
  }
  const licenseNotices = new Set(collectDeclaredLicenseNotices(state?.mapPackage));
  for (const entry of options.requiredLicenseNotices ?? []) {
    const trimmed = redactHonuaExportText(entry.trim()).slice(0, 512);
    if (trimmed.length > 0) licenseNotices.add(trimmed);
  }
  const fidelityWarnings = new Set<string>(
    (options.fidelityWarnings ?? []).map((warning) => redactHonuaExportText(warning).slice(0, 512)),
  );
  // A withheld non-exportable source is a fidelity loss the artifact must
  // admit to; silently shipping a map that is missing a layer is worse than
  // shipping one that says so.
  const omitted = sanitized.sources.filter((source) => source.omitted).map((source) => source.sourceId);
  if (omitted.length > 0) {
    fidelityWarnings.add(
      `${omitted.length} source(s) marked non-exportable were omitted from this export: ${omitted.join(", ")}.`,
    );
  }
  const provenance: {
    exportedAt: string;
    attribution: readonly string[];
    licenseNotices: readonly string[];
    scaleLabel?: string;
    dataFreshnessAt?: string;
    stale?: boolean;
    fidelityWarnings: readonly string[];
    packageId?: string;
    generator: string;
  } = {
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    attribution: [...attribution],
    licenseNotices: [...licenseNotices],
    fidelityWarnings: [...fidelityWarnings],
    generator: "@honua/sdk-js app-platform component kit",
  };
  const scaleLabel = approximateHonuaScaleLabel(sanitized.viewport ?? state?.viewport);
  if (scaleLabel) provenance.scaleLabel = scaleLabel;
  if (sanitized.refreshedAt) provenance.dataFreshnessAt = sanitized.refreshedAt;
  if (typeof sanitized.stale === "boolean") provenance.stale = sanitized.stale;
  if (sanitized.packageId) provenance.packageId = sanitized.packageId;
  return provenance;
}

/**
 * Fail-closed provenance check (REQ-003): every attribution string and licence
 * notice a source or the accepted plan declares must be present on the
 * provenance that ships with the artifact.
 *
 * This exists because provenance is the one part of an export a well-meaning
 * adapter or caller is most likely to "simplify away". Dropping attribution is
 * a licence breach, so it is enforced with the same severity as a credential
 * leak rather than logged as a warning.
 */
export function assertHonuaExportProvenanceComplete(
  provenance: HonuaExportProvenance,
  required: { readonly attribution: readonly string[]; readonly licenseNotices: readonly string[] },
): void {
  const missingAttribution = required.attribution.filter((entry) => !provenance.attribution.includes(entry));
  const missingLicenses = required.licenseNotices.filter((entry) => !provenance.licenseNotices.includes(entry));
  if (missingAttribution.length === 0 && missingLicenses.length === 0) return;
  throw new HonuaExportSafetyError(
    `Export is missing required provenance: ${[...missingAttribution, ...missingLicenses].join("; ")}.`,
    "unsupported-value",
  );
}

// ── the runner ───────────────────────────────────────────────────────────

const ADAPTER_METHODS: Readonly<Record<HonuaExportKind, keyof HonuaExportAdapter>> = {
  print: "print",
  snapshot: "snapshot",
  state: "exportState",
};

function noopRelease(): Promise<void> {
  return Promise.resolve();
}

/** Wraps a payload's `release` so it runs at most once and never rejects. */
function onceRelease(release: (() => void | Promise<void>) | undefined): () => Promise<void> {
  if (!release) return noopRelease;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await release();
    } catch {
      // A failing release is not worth surfacing over the export's own
      // outcome; the resource is the adapter's to leak.
    }
  };
}

function unsupported(
  kind: HonuaExportKind,
  adapterId: string | undefined,
  provenance: HonuaExportProvenance,
  redactions: readonly HonuaExportRedaction[],
  capability: string,
  message: string,
): HonuaExportResult {
  return {
    kind,
    status: "unsupported",
    adapterId,
    provenance,
    redactions,
    ownership: "none",
    release: noopRelease,
    message,
    error: new HonuaCapabilityNotSupportedError(capability, EXPORT_PROTOCOL, adapterId),
  };
}

function failed(
  kind: HonuaExportKind,
  adapterId: string | undefined,
  provenance: HonuaExportProvenance,
  redactions: readonly HonuaExportRedaction[],
  error: HonuaSdkError,
  ownership: HonuaExportOwnership,
): HonuaExportResult {
  return {
    kind,
    status: "error",
    adapterId,
    provenance,
    redactions,
    ownership,
    release: noopRelease,
    message: redactHonuaExportText(error.message),
    error,
  };
}

/**
 * Copies adapter bytes into a buffer the caller owns outright.
 *
 * Adapters routinely hand back a view onto a canvas-backed or pooled buffer
 * they will reuse or free. Copying is what makes the ownership contract
 * ("`bytes` stay valid after `release()`") true rather than aspirational.
 */
function adoptBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * Runs one export end to end. Never throws: every failure mode — no adapter,
 * undeclared kind, missing method, adapter exception, cancellation, unsafe
 * artifact, missing provenance — comes back as a {@link HonuaExportResult}.
 *
 * @example Fail closed with no adapter
 * ```ts doc-test=skip reason="illustrative excerpt over an ambient controller state"
 * const result = await runHonuaExport({ kind: "snapshot", state });
 * result.status;        // "unsupported"
 * result.bytes;         // undefined — no partial artifact is ever produced
 * result.error?.sdkCode // "core.capability-not-supported"
 * ```
 */
export async function runHonuaExport<T>(request: HonuaExportRequest<T>): Promise<HonuaExportResult> {
  const { kind, adapter } = request;
  const sanitization = sanitizeHonuaExportState(
    request.state as HonuaWebComponentState<unknown> | undefined,
    request.nonExportableSourceIds ? { nonExportableSourceIds: request.nonExportableSourceIds } : {},
  );
  const requiredAttribution = [
    ...collectDeclaredAttribution(request.state?.mapPackage),
    ...(request.requiredAttribution ?? []).map((entry) => redactHonuaExportText(entry.trim()).slice(0, 512)),
  ].filter((entry) => entry.length > 0);
  const requiredLicenseNotices = [
    ...collectDeclaredLicenseNotices(request.state?.mapPackage),
    ...(request.requiredLicenseNotices ?? []).map((entry) => redactHonuaExportText(entry.trim()).slice(0, 512)),
  ].filter((entry) => entry.length > 0);
  const baseProvenance = buildHonuaExportProvenance(request.state, sanitization.state, {
    ...(request.requiredAttribution ? { requiredAttribution: request.requiredAttribution } : {}),
    ...(request.requiredLicenseNotices ? { requiredLicenseNotices: request.requiredLicenseNotices } : {}),
    ...(request.exportedAt ? { exportedAt: request.exportedAt } : {}),
  });
  const redactions = sanitization.redactions;
  const title = request.title === undefined ? undefined : redactHonuaExportText(request.title).slice(0, 256);

  if (!adapter) {
    return unsupported(
      kind,
      undefined,
      baseProvenance,
      redactions,
      `export:${kind}`,
      `${describeKind(kind)} requires an explicit export adapter. Without one the component kit cannot read renderer pixels or authorize a state export, so it refuses rather than emitting a partial or credentialed artifact.`,
    );
  }

  let capabilities: HonuaExportCapabilities;
  try {
    capabilities = adapter.describeCapabilities();
  } catch (cause) {
    return failed(
      kind,
      typeof adapter.id === "string" ? adapter.id : undefined,
      baseProvenance,
      redactions,
      new HonuaExportError("error", "Export adapter failed to describe its capabilities.", { cause }),
      "none",
    );
  }
  // Validated rather than trusted, and validated *inside* the guarded region:
  // an adapter that returns undefined, null, or an object without a `kinds`
  // array used to be dereferenced here and reject the whole call with a
  // TypeError, breaking this function's one guarantee — that it always resolves
  // to a structured result. A malformed capability declaration is a contract
  // violation by the adapter and is reported as one.
  const declaredId = (capabilities as { adapterId?: unknown } | null | undefined)?.adapterId;
  const adapterId = (typeof declaredId === "string" && declaredId) || adapter.id || "unknown-adapter";
  const declaredKinds = (capabilities as { kinds?: unknown } | null | undefined)?.kinds;
  if (!capabilities || typeof capabilities !== "object" || !Array.isArray(declaredKinds)) {
    return failed(
      kind,
      typeof adapterId === "string" ? adapterId : undefined,
      baseProvenance,
      redactions,
      new HonuaExportError(
        "error",
        `Export adapter "${String(adapterId)}" returned a malformed capability declaration; describeCapabilities() must return an object with a kinds array.`,
      ),
      "none",
    );
  }

  if (!declaredKinds.includes(kind)) {
    return unsupported(
      kind,
      adapterId,
      baseProvenance,
      redactions,
      `export:${kind}`,
      `Export adapter "${adapterId}" does not declare the "${kind}" export kind.`,
    );
  }
  const method = adapter[ADAPTER_METHODS[kind]];
  if (typeof method !== "function") {
    return unsupported(
      kind,
      adapterId,
      baseProvenance,
      redactions,
      `export:${kind}`,
      `Export adapter "${adapterId}" declares the "${kind}" kind but does not implement ${String(ADAPTER_METHODS[kind])}().`,
    );
  }

  if (request.signal?.aborted) {
    return {
      kind,
      status: "cancelled",
      adapterId,
      provenance: baseProvenance,
      redactions,
      ownership: "released",
      release: noopRelease,
      message: "Export was cancelled before the adapter ran.",
      error: new HonuaAbortError("Export was cancelled before the adapter ran."),
    };
  }

  const context: HonuaExportContext = {
    kind,
    title,
    provenance: baseProvenance,
    state: sanitization.state,
    signal: request.signal,
    mediaType: request.mediaType,
  };

  let payload: HonuaExportPayload;
  try {
    payload = await (method as (context: HonuaExportContext) => Promise<HonuaExportPayload>).call(adapter, context);
  } catch (cause) {
    if (request.signal?.aborted || isAbortLike(cause)) {
      return {
        kind,
        status: "cancelled",
        adapterId,
        provenance: baseProvenance,
        redactions,
        ownership: "released",
        release: noopRelease,
        message: "Export was cancelled.",
        error: new HonuaAbortError("Export was cancelled."),
      };
    }
    // An adapter that already speaks the SDK's error envelope has said
    // something specific and actionable ("the canvas is not readable because
    // the map lacks preserveDrawingBuffer"); wrapping that in a generic message
    // would throw away the only useful part. Its message is redacted by
    // `failed()` like any other.
    return failed(
      kind,
      adapterId,
      baseProvenance,
      redactions,
      cause instanceof HonuaSdkError
        ? cause
        : new HonuaExportError("error", `Export adapter "${adapterId}" failed to produce a ${kind} artifact.`, {
            cause,
          }),
      "none",
    );
  }

  const release = onceRelease(payload?.release);

  if (!payload || typeof payload !== "object") {
    await release();
    return failed(
      kind,
      adapterId,
      baseProvenance,
      redactions,
      new HonuaExportError("error", `Export adapter "${adapterId}" returned no payload for the ${kind} export.`),
      "released",
    );
  }

  if (request.signal?.aborted) {
    await release();
    return {
      kind,
      status: "cancelled",
      adapterId,
      provenance: baseProvenance,
      redactions,
      ownership: "released",
      release: noopRelease,
      message: "Export was cancelled; the adapter's resources were released.",
      error: new HonuaAbortError("Export was cancelled after the adapter produced an artifact."),
    };
  }

  try {
    const result = finalize(
      kind,
      adapterId,
      payload,
      baseProvenance,
      redactions,
      release,
      { attribution: requiredAttribution, licenseNotices: requiredLicenseNotices },
      request.requireEmbeddedProvenance === true,
    );
    return result;
  } catch (cause) {
    await release();
    const error =
      cause instanceof HonuaExportSafetyError
        ? cause
        : new HonuaExportError("error", `Export adapter "${adapterId}" produced an unusable ${kind} artifact.`, {
            cause,
          });
    return failed(kind, adapterId, baseProvenance, redactions, error, "released");
  }
}

function describeKind(kind: HonuaExportKind): string {
  if (kind === "snapshot") return "Snapshot export";
  if (kind === "state") return "State export";
  return "Print export";
}

function isAbortLike(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name;
  return name === "AbortError" || cause instanceof HonuaAbortError;
}

/**
 * Validates and adopts an adapter payload. Throws on anything unsafe — the
 * caller turns that into a `status: "error"` result after releasing the
 * adapter's resources.
 */
function finalize(
  kind: HonuaExportKind,
  adapterId: string,
  payload: HonuaExportPayload,
  baseProvenance: HonuaExportProvenance,
  redactions: readonly HonuaExportRedaction[],
  release: () => Promise<void>,
  required: { readonly attribution: readonly string[]; readonly licenseNotices: readonly string[] },
  requireEmbeddedProvenance: boolean,
): HonuaExportResult {
  const projectedMediaType = projectMediaType(payload.mediaType);
  const adapterWarnings = (payload.fidelityWarnings ?? []).map((warning) =>
    redactHonuaExportText(String(warning)).slice(0, 512),
  );
  const warnings = new Set([...baseProvenance.fidelityWarnings, ...adapterWarnings]);
  if (projectedMediaType.violation && projectedMediaType.mediaType.length > 0) {
    warnings.add(`Export adapter "${adapterId}": ${projectedMediaType.violation}.`);
  }

  // REQ-003: whether the artifact's *bytes* carry the required attribution is a
  // separate fact from whether the export knows the attribution, and conflating
  // them is how an unattributed image ships. An adapter must say which it did;
  // the safe default for an artifact that carries a body is "did not".
  const requiresProvenance = required.attribution.length > 0 || required.licenseNotices.length > 0;
  const provenanceEmbedded = payload.sideEffectOnly === true || payload.provenanceEmbedded === true;
  if (requiresProvenance && !provenanceEmbedded) {
    warnings.add(
      `This artifact's bytes do not carry the attribution and licence notices its sources require (${[
        ...required.attribution,
        ...required.licenseNotices,
      ].join("; ")}). The caller must present them alongside the artifact wherever it is published.`,
    );
  }

  const provenance: HonuaExportProvenance = { ...baseProvenance, fidelityWarnings: [...warnings] };
  assertHonuaExportProvenanceComplete(provenance, required);

  // The strict mode, for callers who cannot present provenance out of band.
  if (requireEmbeddedProvenance && requiresProvenance && !provenanceEmbedded) {
    throw new HonuaExportSafetyError(
      `Export adapter "${adapterId}" cannot embed the required attribution into the ${kind} artifact, and requireEmbeddedProvenance was set. Refusing to emit an artifact whose bytes would travel without the attribution its sources require.`,
      "unsupported-value",
    );
  }

  if (payload.sideEffectOnly === true) {
    return {
      kind,
      status: "ready",
      adapterId,
      sideEffectOnly: true,
      provenance,
      provenanceEmbedded,
      redactions,
      // A side-effect export can still hold resources (a print stylesheet
      // injected into the document, an off-screen render frame). Reporting
      // "none" here told documented callers to skip cleanup and leaked it.
      ownership: payload.release ? "caller-releases" : "none",
      release,
    };
  }

  if (projectedMediaType.mediaType.length === 0) {
    throw new HonuaExportError("error", `Export adapter "${adapterId}" returned an artifact with no media type.`);
  }
  const mediaType = projectedMediaType.mediaType;

  const result: {
    kind: HonuaExportKind;
    status: HonuaExportStatus;
    adapterId: string;
    filename: string;
    mediaType: string;
    bytes?: Uint8Array;
    text?: string;
    provenance: HonuaExportProvenance;
    provenanceEmbedded: boolean;
    redactions: readonly HonuaExportRedaction[];
    ownership: HonuaExportOwnership;
    release: () => Promise<void>;
  } = {
    kind,
    status: "ready",
    adapterId,
    filename: sanitizeHonuaExportFilename({
      ...(payload.filenameHint === undefined ? {} : { title: payload.filenameHint }),
      mediaType,
    }),
    mediaType,
    provenance,
    provenanceEmbedded,
    redactions,
    ownership: payload.release ? "caller-releases" : "none",
    release,
  };

  if (payload.bytes instanceof Uint8Array) {
    // Scanned two ways, because "binary" is not a security boundary. A buffer
    // that decodes cleanly as UTF-8 (SVG, JSON, HTML) is scanned as text; every
    // buffer, including a genuine PNG or PDF that will never decode, also has
    // its printable runs extracted and scanned, so a token inside a PNG tEXt
    // chunk, a JPEG comment, or PDF/XMP metadata cannot ride out under cover of
    // the surrounding binary.
    const decoded = decodeUtf8Strict(payload.bytes);
    if (decoded !== undefined) assertCredentialFreeExportText(decoded, `${kind} export bytes`);
    assertCredentialFreeExportBytes(payload.bytes, `${kind} export bytes`);
    result.bytes = adoptBytes(payload.bytes);
  } else if (typeof payload.text === "string") {
    assertCredentialFreeExportText(payload.text, `${kind} export text`);
    result.text = payload.text;
  } else {
    throw new HonuaExportError(
      "error",
      `Export adapter "${adapterId}" returned neither bytes nor text for the ${kind} export.`,
    );
  }
  for (const warning of provenance.fidelityWarnings) {
    assertCredentialFreeExportText(warning, "export fidelity warning");
  }
  return result as HonuaExportResult;
}

/** Fallback for a media type the adapter got wrong; deliberately inert. */
const SAFE_FALLBACK_MEDIA_TYPE = "application/octet-stream";

/** RFC 9110 token characters, the only thing allowed in a type, subtype, or parameter name. */
const MEDIA_TYPE_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * Parameters an export media type may carry. Everything else is dropped: a
 * media type is echoed onto the result, onto the `honua-export` event, and into
 * a `Content-Type` header by most callers, so an adapter-controlled parameter
 * bag is a credential channel (`text/plain; token=...`) and a header-injection
 * channel. `charset` is the only parameter an export artifact legitimately
 * needs, and its value is checked against the same token grammar.
 */
const MEDIA_TYPE_PARAMETER_ALLOWLIST = new Set(["charset"]);

/** A media type after validation, plus what was rejected. */
interface MediaTypeProjection {
  readonly mediaType: string;
  /** Present when the adapter's value was not usable as given. */
  readonly violation?: string;
}

/**
 * Validates an adapter-supplied media type against a strict `type/subtype`
 * grammar with an allowlisted parameter set, replacing anything else with
 * {@link SAFE_FALLBACK_MEDIA_TYPE} and reporting the substitution.
 *
 * Truncation alone (the previous behavior) is not validation: it bounds length
 * and nothing else, so a value carrying a token, a newline, or arbitrary
 * parameters passed straight through to the result and the event detail.
 */
function projectMediaType(raw: unknown): MediaTypeProjection {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { mediaType: "", violation: "no media type" };
  }
  const value = raw.slice(0, 255);
  const [essence, ...parameters] = value.split(";");
  const [type, subtype, ...extra] = essence.trim().toLowerCase().split("/");
  if (extra.length > 0 || !MEDIA_TYPE_TOKEN.test(type ?? "") || !MEDIA_TYPE_TOKEN.test(subtype ?? "")) {
    return {
      mediaType: SAFE_FALLBACK_MEDIA_TYPE,
      violation: `media type is not a valid type/subtype; substituted ${SAFE_FALLBACK_MEDIA_TYPE}`,
    };
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) {
      dropped += 1;
      continue;
    }
    const name = parameter.slice(0, separator).trim().toLowerCase();
    const parameterValue = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, "");
    if (!MEDIA_TYPE_PARAMETER_ALLOWLIST.has(name) || !MEDIA_TYPE_TOKEN.test(parameterValue)) {
      dropped += 1;
      continue;
    }
    kept.push(`${name}=${parameterValue}`);
  }
  const mediaType = [`${type}/${subtype}`, ...kept].join("; ");
  return dropped === 0
    ? { mediaType }
    : { mediaType, violation: `${dropped} disallowed media-type parameter(s) were dropped` };
}

function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  if (typeof TextDecoder === "undefined") return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Throws `result.error` unless the export succeeded; returns the result otherwise. */
export function assertHonuaExportReady(result: HonuaExportResult): HonuaExportResult {
  if (result.status === "ready") return result;
  throw result.error ?? new HonuaExportError(result.status, result.message ?? "Export did not complete.");
}

// ── built-in adapters ────────────────────────────────────────────────────

/** The minimal renderer surface a snapshot adapter needs. Structurally satisfied by a MapLibre `Map`'s canvas. */
export interface HonuaSnapshotCanvasLike {
  toDataURL?(type?: string, quality?: number): string;
  toBlob?(callback: (blob: unknown) => void, type?: string, quality?: number): void;
}

/** What {@link createHonuaExportAdapter} needs to serve a snapshot. */
export interface HonuaSnapshotSource {
  /**
   * Returns the renderer canvas to read pixels from, or `undefined` when the
   * renderer is not currently readable. Returning `undefined` makes the
   * snapshot fail closed instead of emitting a blank image.
   *
   * The application is asserting, by supplying this, that the canvas was
   * created with `preserveDrawingBuffer: true` (or is otherwise readable) and
   * that reading it is authorized.
   */
  getCanvas(): HonuaSnapshotCanvasLike | undefined;
  /** Preferred media type, default `image/png`. */
  readonly mediaType?: string;
  /** Fidelity caveats the application knows apply to its snapshots. */
  readonly fidelityWarnings?: readonly string[];
  /**
   * Set only if `getCanvas()` returns a canvas that already has the required
   * attribution composited into its pixels (an application that draws a
   * watermark or footer before handing the canvas over). Left `false`, the
   * export reports honestly that the bytes do not carry attribution.
   */
  readonly provenanceEmbedded?: boolean;
}

export interface CreateHonuaExportAdapterOptions {
  readonly id: string;
  /** Supply to enable `snapshot`. Omit and the adapter simply does not declare that kind. */
  readonly snapshot?: HonuaSnapshotSource;
  /** Supply to enable `print`. `createBrowserPrintExportAdapter()` covers the browser-dialog case. */
  readonly print?: (context: HonuaExportContext) => HonuaExportPayload | Promise<HonuaExportPayload>;
  /**
   * Enables the sanitized-state export. `true` uses the runner's own
   * credential-free JSON projection; a function lets the application wrap it
   * (adding its own envelope) while still starting from the sanitized document.
   */
  readonly state?: boolean | ((context: HonuaExportContext) => HonuaExportPayload | Promise<HonuaExportPayload>);
}

const DATA_URL_PREFIX = /^data:([^;,]{1,128})?(;base64)?,/i;

function decodeDataUrl(dataUrl: string): { mediaType: string; bytes: Uint8Array } {
  const match = DATA_URL_PREFIX.exec(dataUrl);
  if (!match) throw new HonuaExportError("error", "Renderer returned a value that is not a data URL.");
  const mediaType = match[1] || "image/png";
  const body = dataUrl.slice(match[0].length);
  if (match[2]) {
    const binary = typeof atob === "function" ? atob(body) : Buffer.from(body, "base64").toString("binary");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { mediaType, bytes };
  }
  return { mediaType, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
}

/**
 * Builds an export adapter from capabilities the application explicitly grants.
 *
 * Everything here is structural: no `maplibre-gl`, `cesium`, PDF writer, or
 * image encoder is imported, so wiring an adapter costs a consumer bundle
 * nothing beyond the object it passes in (NFR-001).
 *
 * @example
 * ```ts doc-test=skip reason="requires a live MapLibre map instance"
 * const adapter = createHonuaExportAdapter({
 *   id: "my-app",
 *   snapshot: { getCanvas: () => map.getCanvas() },  // map created with preserveDrawingBuffer
 *   state: true,
 * });
 * printExportElement.exportAdapter = adapter;
 * ```
 */
export function createHonuaExportAdapter(options: CreateHonuaExportAdapterOptions): HonuaExportAdapter {
  const kinds: HonuaExportKind[] = [];
  if (options.print) kinds.push("print");
  if (options.snapshot) kinds.push("snapshot");
  if (options.state) kinds.push("state");
  const snapshotMediaTypes = options.snapshot ? [options.snapshot.mediaType ?? "image/png"] : undefined;

  const adapter: HonuaExportAdapter & {
    print?: NonNullable<HonuaExportAdapter["print"]>;
    snapshot?: NonNullable<HonuaExportAdapter["snapshot"]>;
    exportState?: NonNullable<HonuaExportAdapter["exportState"]>;
  } = {
    id: options.id,
    describeCapabilities: () => ({
      adapterId: options.id,
      kinds: [...kinds],
      cancellable: true,
      ...(snapshotMediaTypes ? { snapshotMediaTypes } : {}),
    }),
  };

  if (options.print) adapter.print = options.print;

  if (options.snapshot) {
    const source = options.snapshot;
    adapter.snapshot = (context) => {
      const canvas = source.getCanvas();
      if (!canvas) {
        throw new HonuaExportError(
          "error",
          "The renderer canvas is not currently readable, so no snapshot was produced. A map must be created with preserveDrawingBuffer: true for its pixels to be readable.",
        );
      }
      const mediaType = context.mediaType ?? source.mediaType ?? "image/png";
      if (typeof canvas.toDataURL !== "function") {
        throw new HonuaExportError("error", "The supplied renderer canvas does not implement toDataURL().");
      }
      const decoded = decodeDataUrl(canvas.toDataURL(mediaType));
      return {
        mediaType: decoded.mediaType,
        bytes: decoded.bytes,
        filenameHint: context.title ?? context.provenance.packageId ?? "snapshot",
        fidelityWarnings: source.fidelityWarnings ?? [],
        // Reading a canvas captures the map's pixels and nothing else: MapLibre
        // renders attribution as DOM siblings of the canvas, so it is provably
        // absent from these bytes. Declaring `true` here would make the result
        // claim an attribution guarantee the image does not carry, which is the
        // licence-breaking failure REQ-003 exists to prevent. The runner turns
        // this into an explicit fidelity warning naming what the caller must
        // present, or a hard failure under `requireEmbeddedProvenance`.
        // An adapter that composites a watermark or footer should declare true.
        provenanceEmbedded: source.provenanceEmbedded === true,
      };
    };
  }

  if (options.state) {
    const custom = typeof options.state === "function" ? options.state : undefined;
    adapter.exportState =
      custom ??
      ((context) => ({
        mediaType: "application/json",
        text: JSON.stringify({ ...context.state, provenance: context.provenance }, null, 2),
        filenameHint: context.title ?? context.provenance.packageId ?? "state",
      }));
  }

  return adapter;
}

/** The window surface {@link createBrowserPrintExportAdapter} needs. */
export interface HonuaPrintWindowLike {
  print(): void;
}

/**
 * The browser-print adapter: the one export the component kit can serve without
 * application help, because `window.print()` reads no pixels and serializes no
 * state — the browser prints what it already renders, under the user's own
 * session.
 *
 * It is a *default* for `print` only. Snapshot and state export deliberately
 * have no equivalent built-in, because both require reading privileged data.
 */
export function createBrowserPrintExportAdapter(
  windowLike: HonuaPrintWindowLike | undefined = typeof window === "undefined" ? undefined : window,
): HonuaExportAdapter {
  return {
    id: "honua-browser-print",
    describeCapabilities: () => ({
      adapterId: "honua-browser-print",
      kinds: windowLike && typeof windowLike.print === "function" ? ["print"] : [],
      cancellable: false,
    }),
    print: () => {
      if (!windowLike || typeof windowLike.print !== "function") {
        throw new HonuaExportError("error", "Window printing is unavailable in this environment.");
      }
      windowLike.print();
      return {
        mediaType: "application/vnd.honua.print-dialog",
        sideEffectOnly: true,
        fidelityWarnings: [
          "Browser print reproduces the on-screen layout only; page breaks, scale, and layer legibility are controlled by the print stylesheet, not by the map.",
        ],
      };
    },
  };
}
