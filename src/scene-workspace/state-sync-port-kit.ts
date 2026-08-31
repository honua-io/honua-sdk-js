/**
 * Shared machinery for the shipped renderer state-sync ports.
 *
 * `createSceneStateSynchronizer` is a transport: it revisions, coalesces, and
 * delivers, but it never touches a renderer. Everything a *real* port has to get
 * right — sequence discipline, echo suppression, bounded convergence, listener
 * lifecycles, and honest degradation reporting — lives here once so the
 * MapLibre and Cesium ports differ only in the renderer they drive.
 *
 * ## Echo suppression and convergence
 *
 * Every renderer change loop has the same hazard: state applied *from* the
 * shared envelope makes the renderer fire its own change event, which would be
 * re-published as a local change and bounce back forever. Two mechanisms close
 * the loop, and both are needed:
 *
 * 1. **Applied-signature matching.** Immediately after applying a delivery the
 *    port reads the renderer back and records a quantized signature of what the
 *    renderer actually holds. The next renderer event whose signature matches is
 *    an echo: it is published once with `causeRevision` set to the applied
 *    revision, which the synchronizer classifies as `loop-suppressed` and drops.
 *    Publishing the acknowledgement rather than swallowing it keeps the loop
 *    closure observable instead of invisible.
 * 2. **Lossy sides do not write back.** When a renderer cannot hold what it was
 *    given (a globe pitch a 2D map clamps, a pose outside the zoom range) the
 *    port applies its best effort, records a {@link SceneStateSyncPortDegradation},
 *    and leaves the shared value alone. Writing the clamped value back would
 *    drag every other view down to the least capable renderer's limits *and*
 *    would be the one shape that can oscillate. With this rule a change
 *    converges in one round trip: origin publishes, target applies, target
 *    acknowledges, done.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface.
 * @module
 */

import type { SceneCameraDegradationCode } from "./camera-correspondence.js";
import {
  HonuaSceneStateSyncError,
  SCENE_STATE_SYNC_KIND,
  SCENE_STATE_SYNC_VERSION,
  type SceneStateSyncAttributionValue,
  type SceneStateSyncIdentity,
  type SceneStateSyncInput,
  type SceneStateSyncPort,
  type SceneStateSyncRenderer,
  type SceneStateSyncSlice,
  type SceneStateSyncValueMap,
} from "./state-sync.js";

/**
 * Named ways a shipped port could not fully honour a slice. Camera codes are
 * shared with the pure projection helpers so one vocabulary covers both.
 */
export type SceneStateSyncPortDegradationCode =
  | SceneCameraDegradationCode
  | "selection-source-missing"
  | "selection-target-unresolved"
  | "selection-not-fully-expressible"
  | "filters-no-target-layers"
  | "filters-layer-rejected"
  | "filters-clause-not-expressible"
  | "time-field-unconfigured"
  | "time-clock-unavailable"
  | "time-clock-host-owned"
  | "time-plan-rejected"
  | "detail-target-unresolved"
  | "attribution-id-rejected";

/** One reported shortfall, attributed to the port and revision that caused it. */
export interface SceneStateSyncPortDegradation {
  readonly portId: string;
  readonly slice: SceneStateSyncSlice;
  readonly code: SceneStateSyncPortDegradationCode;
  readonly message: string;
  readonly at: string;
  readonly revision?: number;
  /** What the shared state asked for, when the shortfall is numeric. */
  readonly requested?: number;
  /** What the renderer was given instead. */
  readonly applied?: number;
}

/** Optional quantitative context for {@link PortCore.degrade}. */
export interface SceneStateSyncPortDegradationDetail {
  readonly revision?: number;
  readonly requested?: number;
  readonly applied?: number;
}

/**
 * A {@link SceneStateSyncPort} bound to a live renderer.
 *
 * Beyond the transport contract it adds the two things a real binding needs: a
 * way for the host application to publish renderer-origin state the renderer
 * has no event for (selection, filters, time), and an owned teardown.
 */
export interface SceneStateSyncRendererPort extends SceneStateSyncPort {
  /**
   * Publish a renderer-origin change. Returns what the port did with it:
   * `published` for a genuine local change, `acknowledged` for an echo of a
   * delivery this port applied, `duplicate` when nothing changed, and `disposed`
   * after teardown.
   */
  publish<Slice extends SceneStateSyncSlice>(
    slice: Slice,
    value: SceneStateSyncValueMap[Slice],
  ): SceneStateSyncPublishOutcome;
  /**
   * Read a slice back out of the live renderer and publish it if it changed.
   *
   * The push path (renderer events) is wired automatically where the renderer
   * has one; this is the pull complement for slices whose change notification is
   * frame-driven or absent. `unsupported` means this renderer holds no readable
   * state for the slice.
   */
  readFromRenderer(slice: SceneStateSyncSlice): SceneStateSyncPublishOutcome | "unsupported";
  /** Everything this port could not fully honour, oldest first and bounded. */
  readonly degradations: readonly SceneStateSyncPortDegradation[];
  readonly disposed: boolean;
  /** Release every renderer listener this port owns. Idempotent. */
  dispose(): void;
}

/** What a port did with a renderer-origin value. */
export type SceneStateSyncPublishOutcome = "published" | "acknowledged" | "duplicate" | "disposed";

const MAX_DEGRADATIONS = 256;
const MAX_ATTRIBUTION_ID_LENGTH = 256;
const MAX_ATTRIBUTION_SOURCE_LENGTH = 4_096;

/**
 * Reduce free-form attribution text to the credential-free identifier charset
 * the `attribution` slice accepts.
 *
 * The slice carries identifiers, not markup: `"County orthophotography"` becomes
 * `county-orthophotography`, and `<a href="...">OpenStreetMap</a> contributors`
 * becomes `openstreetmap-contributors`. Anything with no identifier characters
 * at all — or anything carrying a URL with credentials — yields `undefined`
 * rather than a lossy guess, and the caller reports it as a degradation. The
 * safe-id rule is a boundary to satisfy, not to relax.
 *
 * Reduction is a single bounded character pass rather than a chain of regular
 * expressions: attribution text is attacker-influenceable (it arrives from a
 * style document or a provider), and markup stripping with a pattern is a
 * polynomial-backtracking shape.
 */
export function sceneAttributionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ATTRIBUTION_SOURCE_LENGTH) return undefined;
  if (containsCredentialBearingUrl(value)) return undefined;
  let slug = "";
  let inTag = false;
  let separatorPending = false;
  for (const character of value) {
    if (character === "<") {
      inTag = true;
      separatorPending = true;
      continue;
    }
    if (character === ">") {
      inTag = false;
      separatorPending = true;
      continue;
    }
    if (inTag) continue;
    const lowered = character.toLowerCase();
    if (!isAttributionCharacter(lowered)) {
      separatorPending = true;
      continue;
    }
    // The charset allows `.`, `_`, and `:` inside an identifier but not as its
    // first character, so a leading run of them is dropped rather than emitted.
    if (slug.length === 0 && !isAlphanumeric(lowered)) continue;
    if (separatorPending && slug.length > 0) slug += "-";
    separatorPending = false;
    slug += lowered;
    if (slug.length > MAX_ATTRIBUTION_ID_LENGTH) return undefined;
  }
  while (slug.length > 0 && !isAlphanumeric(slug.charAt(slug.length - 1))) slug = slug.slice(0, -1);
  return slug.length === 0 ? undefined : slug;
}

function isAlphanumeric(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "0" && character <= "9");
}

/** The identifier charset minus `-`, which the pass emits as a separator. */
function isAttributionCharacter(character: string): boolean {
  return isAlphanumeric(character) || character === "." || character === "_" || character === ":";
}

/**
 * Whether the text carries a URL with userinfo (`scheme://user:secret@host`).
 *
 * The slug reduction below keeps `:` and `.`, so a credential pair would
 * survive it as a readable token. Scanned character by character rather than
 * with a regular expression so a hostile string cannot drive backtracking.
 */
function containsCredentialBearingUrl(value: string): boolean {
  const AUTHORITY_TERMINATORS = "/?# \t\n";
  let index = value.indexOf("://");
  while (index !== -1) {
    const authorityStart = index + 3;
    let end = authorityStart;
    while (end < value.length && !AUTHORITY_TERMINATORS.includes(value[end] as string)) end += 1;
    if (value.slice(authorityStart, end).includes("@")) return true;
    index = value.indexOf("://", authorityStart);
  }
  return false;
}

/**
 * Build an `attribution` slice value from live credit strings, dropping what
 * cannot be reduced to a safe identifier and de-duplicating the rest.
 */
export function sceneAttributionValue(values: Iterable<unknown>): SceneStateSyncAttributionValue {
  const ids = new Set<string>();
  for (const value of values) {
    const id = sceneAttributionId(value);
    if (id !== undefined) ids.add(id);
  }
  return Object.freeze({ ids: Object.freeze([...ids].sort()) });
}

export interface PortCoreOptions {
  readonly id: string;
  readonly renderer: SceneStateSyncRenderer;
  readonly identity: SceneStateSyncIdentity;
  readonly now?: () => string;
  readonly onDegraded?: (degradation: SceneStateSyncPortDegradation) => void;
  /** Attach renderer listeners; returns the detach. Called on first subscriber. */
  readonly bind?: () => () => void;
}

export interface PortCore {
  readonly id: string;
  readonly degradations: readonly SceneStateSyncPortDegradation[];
  readonly disposed: boolean;
  subscribe(listener: (event: SceneStateSyncInput) => void, signal?: AbortSignal): () => void;
  publish<Slice extends SceneStateSyncSlice>(
    slice: Slice,
    value: SceneStateSyncValueMap[Slice],
  ): SceneStateSyncPublishOutcome;
  /**
   * Register what counts as an echo of `revision`.
   *
   * Pass the renderer read-back first and the delivered value second when they
   * differ: a renderer that clamped what it was given must acknowledge its own
   * clamped read-back instead of publishing it as a new local change.
   */
  markApplied(slice: SceneStateSyncSlice, revision: number, ...values: readonly unknown[]): void;
  degrade(
    slice: SceneStateSyncSlice,
    code: SceneStateSyncPortDegradationCode,
    message: string,
    detail?: SceneStateSyncPortDegradationDetail,
  ): void;
  dispose(): void;
}

/** Build the shared listener/sequence/echo core a shipped port is wrapped around. */
export function createPortCore(options: PortCoreOptions): PortCore {
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(event: SceneStateSyncInput) => void>();
  const abortReleases = new Map<(event: SceneStateSyncInput) => void, () => void>();
  const degradations: SceneStateSyncPortDegradation[] = [];
  const appliedSignatures = new Map<
    SceneStateSyncSlice,
    { readonly revision: number; readonly signatures: ReadonlySet<string> }
  >();
  const lastSignatures = new Map<SceneStateSyncSlice, string>();
  let unbind: (() => void) | undefined;
  let sequence = 0;
  let disposed = false;

  function ensureBound(): void {
    if (unbind === undefined && listeners.size > 0 && options.bind) unbind = options.bind();
  }

  function releaseIfIdle(): void {
    if (listeners.size === 0 && unbind) {
      const release = unbind;
      unbind = undefined;
      release();
    }
  }

  function emit(slice: SceneStateSyncSlice, value: unknown, causeRevision?: number): void {
    sequence += 1;
    const event = Object.freeze({
      kind: SCENE_STATE_SYNC_KIND,
      version: SCENE_STATE_SYNC_VERSION,
      sequence,
      emittedAt: now(),
      slice,
      value,
      identity: options.identity,
      ...(causeRevision === undefined ? {} : { causeRevision }),
    }) as SceneStateSyncInput;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A synchronizer that rejects one event must not break the renderer.
      }
    }
  }

  return {
    id: options.id,
    get degradations() {
      return Object.freeze([...degradations]);
    },
    get disposed() {
      return disposed;
    },
    subscribe(listener, signal) {
      if (typeof listener !== "function")
        throw new HonuaSceneStateSyncError("invalid-input", "listener must be a function");
      if (disposed) return () => undefined;
      listeners.add(listener);
      ensureBound();
      const release = (): void => {
        if (!listeners.delete(listener)) return;
        abortReleases.get(listener)?.();
        abortReleases.delete(listener);
        releaseIfIdle();
      };
      if (signal) {
        if (signal.aborted) {
          release();
          return () => undefined;
        }
        const onAbort = (): void => release();
        signal.addEventListener("abort", onAbort, { once: true });
        abortReleases.set(listener, () => signal.removeEventListener("abort", onAbort));
      }
      return release;
    },
    publish(slice, value) {
      if (disposed) return "disposed";
      const signature = sliceSignature(slice, value);
      const applied = appliedSignatures.get(slice);
      if (applied?.signatures.has(signature)) {
        appliedSignatures.delete(slice);
        lastSignatures.set(slice, signature);
        emit(slice, value, applied.revision);
        return "acknowledged";
      }
      if (lastSignatures.get(slice) === signature) return "duplicate";
      appliedSignatures.delete(slice);
      lastSignatures.set(slice, signature);
      emit(slice, value);
      return "published";
    },
    markApplied(slice, revision, ...values) {
      const signatures = new Set(values.map((value) => sliceSignature(slice, value)));
      appliedSignatures.set(slice, { revision, signatures });
      const first = values[0];
      lastSignatures.set(slice, sliceSignature(slice, first));
    },
    degrade(slice, code, message, detail = {}) {
      const degradation = Object.freeze({
        portId: options.id,
        slice,
        code,
        message,
        at: now(),
        ...(detail.revision === undefined ? {} : { revision: detail.revision }),
        ...(detail.requested === undefined ? {} : { requested: detail.requested }),
        ...(detail.applied === undefined ? {} : { applied: detail.applied }),
      });
      degradations.push(degradation);
      if (degradations.length > MAX_DEGRADATIONS) degradations.splice(0, degradations.length - MAX_DEGRADATIONS);
      try {
        options.onDegraded?.(degradation);
      } catch {
        // Observers cannot break renderer application.
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of abortReleases.values()) release();
      abortReleases.clear();
      listeners.clear();
      appliedSignatures.clear();
      lastSignatures.clear();
      releaseIfIdle();
    },
  };
}

/**
 * Quantized equality signature for a slice value.
 *
 * Camera values are quantized before comparison because a renderer round-trip
 * is never bit-exact: Cesium re-derives longitude/latitude/height from a
 * Cartesian position, and a 2D map re-derives a zoom from a scale. Without a
 * tolerance every applied camera would look like a fresh local change and the
 * loop would never converge. The quantization is ~1 cm horizontally, nine
 * significant digits of height, and 1/10000 of a degree of orientation — far
 * below what any renderer displays, and far above float round-trip noise.
 */
export function sliceSignature(slice: SceneStateSyncSlice, value: unknown): string {
  if (slice !== "camera") return stableStringify(value);
  if (value === null || typeof value !== "object") return stableStringify(value);
  const camera = value as Record<string, unknown>;
  return [
    quantize(camera.longitude, 7),
    quantize(camera.latitude, 7),
    quantizeSignificant(camera.height),
    quantize(camera.heading, 4),
    quantize(camera.pitch, 4),
    quantize(camera.roll, 4),
  ].join("|");
}

function quantize(value: unknown, decimals: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const fixed = value.toFixed(decimals);
  return fixed === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : fixed;
}

function quantizeSignificant(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Number(value.toPrecision(9)).toString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
