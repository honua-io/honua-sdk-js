import { HonuaCogError, type HonuaCogErrorCode } from "./errors.js";
import type { StacCogAssetSession } from "./session.js";
import type {
  CogBand,
  CogInspection,
  CogResampling,
  CogTransferLedger,
  CogWindowRequest,
  CogWindowResult,
} from "./types.js";

const WEB_MERCATOR_MAX = 20_037_508.342789244;
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
export const DEFAULT_COG_MAPLIBRE_RENDER_LIMITS = Object.freeze({
  maxOutputPixels: 1_048_576,
  maxSourcePixels: 4_194_304,
  maxEncodedBytes: 8 * 1024 * 1024,
  maxOutputDimension: 4_096,
  maxDiagnostics: 128,
});
const HARD_RENDER_LIMITS = Object.freeze({
  maxOutputPixels: 4_194_304,
  maxSourcePixels: 16_777_216,
  maxEncodedBytes: 32 * 1024 * 1024,
  maxOutputDimension: 8_192,
  maxDiagnostics: 1_024,
});
const OBSOLETE_RENDER = Symbol("honua-cog-maplibre-obsolete");
const DISPOSED_RENDER = Symbol("honua-cog-maplibre-disposed");

export type CogMapLibreState = "initializing" | "ready" | "outside-extent" | "refused" | "failed" | "disposed";

export type CogMapLibreDiagnosticCode =
  | "refresh-started"
  | "refresh-obsolete"
  | "viewport-outside-extent"
  | "window-refused"
  | "window-rendered"
  | "render-failed"
  | "cleanup-complete"
  | "cleanup-failed";

export interface CogMapLibreDiagnostic {
  readonly sequence: number;
  readonly generation: number;
  readonly code: CogMapLibreDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly stage: "plan" | "read" | "encode" | "map" | "dispose";
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface CogMapLibreViewport {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly zoom: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface CogMapLibreRenderEvidence {
  readonly generation: number;
  readonly viewport: CogMapLibreViewport;
  readonly window: CogWindowRequest;
  readonly coordinates: CogMapLibreCoordinates;
  readonly encodedBytes: number;
  readonly estimatedSourcePixels: number;
  readonly transfer: CogTransferLedger;
}

export interface CogMapLibreSnapshot {
  readonly state: CogMapLibreState;
  readonly generation: number;
  readonly sourceId: string;
  readonly layerId: string;
  readonly mounted: boolean;
  readonly diagnostics: readonly CogMapLibreDiagnostic[];
  readonly lastRender?: CogMapLibreRenderEvidence;
}

export type CogMapLibreCoordinates = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export type CogMapLibreBandMapping =
  | { readonly mode: "grayscale"; readonly band: number; readonly alpha?: number }
  | {
      readonly mode: "rgb";
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha?: number;
    };

export interface CogMapLibreRenderLimitOptions {
  readonly maxOutputPixels?: number;
  readonly maxSourcePixels?: number;
  readonly maxEncodedBytes?: number;
  readonly maxOutputDimension?: number;
  readonly maxDiagnostics?: number;
}

export interface MountStacCogAssetToMapLibreOptions {
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly beforeId?: string;
  readonly bands?: CogMapLibreBandMapping;
  readonly resampling?: CogResampling;
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly limits?: CogMapLibreRenderLimitOptions;
  /** The mount owns its dedicated session by default. */
  readonly disposeSession?: boolean;
}

export interface CogMapLibreBoundsLike {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

export interface CogMapLibreCanvasLike {
  readonly width: number;
  readonly height: number;
}

export interface CogMapLibreImageSourceLike {
  updateImage(options: { url: string; coordinates?: CogMapLibreCoordinates }): unknown;
}

/** Minimal caller-injected MapLibre surface. No MapLibre runtime is imported. */
export interface StacCogAssetToMapLibreMap {
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  getBounds(): CogMapLibreBoundsLike;
  getZoom(): number;
  getCanvas(): CogMapLibreCanvasLike;
  on(event: "moveend" | "resize", listener: () => void): unknown;
  off(event: "moveend" | "resize", listener: () => void): unknown;
}

export type CogMapLibreErrorCode = Extract<
  HonuaCogErrorCode,
  | "unsupported-crs"
  | "unsupported-extent"
  | "unsupported-nodata"
  | "unsupported-sample-type"
  | "invalid-window"
  | "render-unavailable"
  | "render-overflow"
  | "encoding-failed"
  | "map-conflict"
  | "map-mutation-failed"
  | "source-drift"
  | "aborted"
  | "obsolete-read"
  | "disposed"
>;

export class HonuaCogMapLibreError extends HonuaCogError {
  constructor(
    public readonly code: CogMapLibreErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "HonuaCogMapLibreError";
  }
}

export interface MountedStacCogAssetToMapLibre {
  readonly sourceId: string;
  readonly layerId: string;
  readonly state: CogMapLibreState;
  /** Settles after the first bounded render, outside/refused decision, or typed failure. */
  readonly ready: Promise<CogMapLibreSnapshot>;
  refresh(): Promise<CogMapLibreSnapshot>;
  snapshot(): CogMapLibreSnapshot;
  dispose(): Promise<void>;
}

interface RenderLimits {
  readonly maxOutputPixels: number;
  readonly maxSourcePixels: number;
  readonly maxEncodedBytes: number;
  readonly maxOutputDimension: number;
  readonly maxDiagnostics: number;
}

interface AssetExtent {
  readonly crs: "EPSG:4326" | "OGC:CRS84" | "EPSG:3857";
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface PlannedBand {
  readonly band: number;
  readonly nodata?: number;
}

interface PlannedBands {
  readonly mode: "grayscale" | "rgb";
  readonly requested: readonly number[];
  readonly color: readonly PlannedBand[];
  readonly alpha?: number;
}

interface RenderPlan {
  readonly viewport: CogMapLibreViewport;
  readonly request: CogWindowRequest;
  readonly coordinates: CogMapLibreCoordinates;
  readonly bands: PlannedBands;
  readonly estimatedSourcePixels: number;
}

interface ActiveRefresh {
  readonly generation: number;
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

class StacCogMapLibreMount implements MountedStacCogAssetToMapLibre {
  readonly sourceId: string;
  readonly layerId: string;
  readonly ready: Promise<CogMapLibreSnapshot>;
  private readonly map: StacCogAssetToMapLibreMap;
  private readonly session: StacCogAssetSession;
  private readonly options: MountStacCogAssetToMapLibreOptions;
  private readonly limits: RenderLimits;
  private readonly lifecycle = new AbortController();
  private readonly eventListener = () => {
    void this.refresh().catch(() => undefined);
  };
  private readonly pending = new Set<Promise<CogMapLibreSnapshot>>();
  private diagnosticsLog: CogMapLibreDiagnostic[] = [];
  private diagnosticSequence = 0;
  private generation = 0;
  private workflowState: CogMapLibreState = "initializing";
  private active: ActiveRefresh | undefined;
  private inspection: CogInspection | undefined;
  private extent: AssetExtent | undefined;
  private plannedBands: PlannedBands | undefined;
  private ownedSource: unknown;
  private layerMounted = false;
  private eventsAttached = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private lastRender: CogMapLibreRenderEvidence | undefined;

  constructor(
    map: StacCogAssetToMapLibreMap,
    session: StacCogAssetSession,
    options: MountStacCogAssetToMapLibreOptions,
  ) {
    this.map = map;
    this.session = session;
    this.options = normalizeOptions(options);
    this.sourceId = boundedId(this.options.sourceId ?? "honua-cog");
    this.layerId = boundedId(this.options.layerId ?? `${this.sourceId}-raster`);
    this.limits = normalizeRenderLimits(this.options.limits);
    validateMap(map);
    if (map.getSource(this.sourceId) !== undefined) {
      throw renderError("map-conflict", `MapLibre source "${this.sourceId}" already exists.`, {
        sourceId: this.sourceId,
      });
    }
    if (map.getLayer(this.layerId) !== undefined) {
      throw renderError("map-conflict", `MapLibre layer "${this.layerId}" already exists.`, {
        layerId: this.layerId,
      });
    }

    this.ready = this.refresh().then((snapshot) => {
      this.assertActive();
      this.attachEvents();
      return snapshot;
    });
    void this.ready.catch(() => undefined);
  }

  get state(): CogMapLibreState {
    return this.workflowState;
  }

  refresh(): Promise<CogMapLibreSnapshot> {
    const promise = this.runRefresh();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  snapshot(): CogMapLibreSnapshot {
    return Object.freeze({
      state: this.workflowState,
      generation: this.generation,
      sourceId: this.sourceId,
      layerId: this.layerId,
      mounted: this.ownedSource !== undefined && this.layerMounted,
      diagnostics: Object.freeze([...this.diagnosticsLog]),
      ...(this.lastRender ? { lastRender: this.lastRender } : {}),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.workflowState = "disposed";
    this.generation += 1;
    this.lifecycle.abort(DISPOSED_RENDER);
    this.active?.controller.abort(DISPOSED_RENDER);
    this.active?.cleanup();
    this.active = undefined;
    this.detachEvents();

    this.disposePromise = (async () => {
      const cleanupErrors = this.removeOwnedObjects();
      if (this.options.disposeSession !== false) {
        try {
          await this.session.dispose();
        } catch (cause) {
          cleanupErrors.push(`session:${errorMessage(cause)}`);
        }
      }
      await Promise.allSettled([...this.pending]);
      this.pushDiagnostic({
        generation: this.generation,
        code: cleanupErrors.length === 0 ? "cleanup-complete" : "cleanup-failed",
        severity: cleanupErrors.length === 0 ? "info" : "warning",
        stage: "dispose",
        message:
          cleanupErrors.length === 0
            ? "COG MapLibre resources were released."
            : "COG MapLibre cleanup could not release every owned resource.",
        ...(cleanupErrors.length > 0 ? { detail: Object.freeze({ errors: Object.freeze(cleanupErrors) }) } : {}),
      });
    })();
    await this.disposePromise;
  }

  private async runRefresh(): Promise<CogMapLibreSnapshot> {
    this.assertActive();
    if (this.active) {
      const obsolete = this.active;
      obsolete.controller.abort(OBSOLETE_RENDER);
      obsolete.cleanup();
      this.pushDiagnostic({
        generation: obsolete.generation,
        code: "refresh-obsolete",
        severity: "info",
        stage: "read",
        message: "A newer viewport refresh superseded this COG read.",
      });
    }

    const generation = ++this.generation;
    const linked = linkedController(this.lifecycle.signal);
    const controller = linked.controller;
    this.active = { generation, controller, cleanup: linked.cleanup };
    this.workflowState = "initializing";
    this.pushDiagnostic({
      generation,
      code: "refresh-started",
      severity: "info",
      stage: "plan",
      message: "Started a bounded COG viewport refresh.",
    });

    try {
      const inspection = this.inspection ?? (await this.session.inspect({ signal: controller.signal }));
      this.assertCurrent(generation, controller.signal);
      this.inspection = inspection;
      this.extent ??= validateExtent(inspection);
      this.plannedBands ??= planBands(inspection.bands, this.options.bands);
      const viewport = readViewport(this.map);
      const plan = planWindow(
        inspection,
        this.extent,
        this.plannedBands,
        viewport,
        this.options.resampling ?? "bilinear",
        this.limits,
      );
      if (!plan) {
        this.assertCurrent(generation, controller.signal);
        this.workflowState = "outside-extent";
        this.pushDiagnostic({
          generation,
          code: "viewport-outside-extent",
          severity: "info",
          stage: "plan",
          message: "The current MapLibre viewport does not intersect the COG extent.",
          detail: Object.freeze({ viewport }),
        });
        return this.snapshot();
      }

      const result = await this.session.readWindow(plan.request, { signal: controller.signal });
      this.assertCurrent(generation, controller.signal);
      const encoded = encodeWindow(result, plan.bands, this.limits);
      // Encoding is synchronous in browsers. This yield makes the mutation
      // boundary explicit and lets a queued newer viewport invalidate it.
      await Promise.resolve();
      this.assertCurrent(generation, controller.signal);
      this.applyImage(generation, encoded.url, plan.coordinates);
      this.assertCurrent(generation, controller.signal);

      this.lastRender = Object.freeze({
        generation,
        viewport: plan.viewport,
        window: result.window,
        coordinates: plan.coordinates,
        encodedBytes: encoded.bytes,
        estimatedSourcePixels: plan.estimatedSourcePixels,
        transfer: result.transfer,
      });
      this.workflowState = "ready";
      this.pushDiagnostic({
        generation,
        code: "window-rendered",
        severity: "info",
        stage: "map",
        message: "Rendered a bounded COG window into the MapLibre image source.",
        detail: Object.freeze({
          zoom: plan.viewport.zoom,
          window: result.window,
          outputWidth: result.width,
          outputHeight: result.height,
          overviewDecimation: result.window.sampling?.overviewDecimation ?? 1,
          resampling: result.window.sampling?.resampling ?? "nearest",
          estimatedSourcePixels: plan.estimatedSourcePixels,
          encodedBytes: encoded.bytes,
          ranges: result.transfer.requests,
          bytesFetched: result.transfer.bytesFetched,
        }),
      });
      return this.snapshot();
    } catch (cause) {
      const error = this.refreshError(cause, generation, controller.signal);
      if (error.code === "obsolete-read" || error.code === "disposed") throw error;
      if (this.generation === generation && error.code === "render-overflow") {
        this.workflowState = "refused";
        this.pushDiagnostic({
          generation,
          code: "window-refused",
          severity: "warning",
          stage: "plan",
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
        });
        return this.snapshot();
      }
      if (this.generation === generation) {
        this.workflowState = "failed";
        this.pushDiagnostic({
          generation,
          code: "render-failed",
          severity: "error",
          stage: failureStage(error.code),
          message: error.message,
          detail: Object.freeze({ code: error.code, ...(error.detail ?? {}) }),
        });
      }
      throw error;
    } finally {
      linked.cleanup();
      if (this.active?.generation === generation) this.active = undefined;
    }
  }

  private applyImage(generation: number, url: string, coordinates: CogMapLibreCoordinates): void {
    if (this.ownedSource === undefined) {
      if (this.map.getLayer(this.layerId) !== undefined) {
        throw renderError("map-conflict", `MapLibre layer "${this.layerId}" appeared before COG mutation.`, {
          layerId: this.layerId,
        });
      }
      const sourceSpec = Object.freeze({ type: "image", url, coordinates });
      this.assertMutationCurrent(generation, undefined);
      try {
        this.map.addSource(this.sourceId, sourceSpec);
      } catch (cause) {
        this.captureAddedSource();
        this.rollbackFirstMount();
        throw renderError(
          "map-mutation-failed",
          `Failed to add MapLibre COG source "${this.sourceId}".`,
          { sourceId: this.sourceId },
          cause,
        );
      }
      this.captureAddedSource();
      if (!isImageSource(this.ownedSource)) {
        this.rollbackFirstMount();
        throw renderError("source-drift", "MapLibre did not expose the added COG image source.", {
          sourceId: this.sourceId,
        });
      }

      try {
        const layerSpec = Object.freeze({
          id: this.layerId,
          type: "raster",
          source: this.sourceId,
          paint: Object.freeze({ "raster-fade-duration": 0, ...(this.options.paint ?? {}) }),
          ...(this.options.layout ? { layout: this.options.layout } : {}),
          metadata: Object.freeze({ "honua:format": "cog", "honua:asset": this.session.assetUrl }),
        });
        if (this.map.getLayer(this.layerId) !== undefined) {
          throw renderError("map-conflict", `MapLibre layer "${this.layerId}" appeared before COG layer mutation.`, {
            layerId: this.layerId,
          });
        }
        this.assertMutationCurrent(generation, this.ownedSource);
        this.map.addLayer(layerSpec, this.options.beforeId);
        this.assertCurrent(generation, this.active?.controller.signal);
        this.layerMounted = true;
      } catch (cause) {
        this.rollbackFirstMount();
        if (cause instanceof HonuaCogMapLibreError) throw cause;
        throw renderError(
          "map-mutation-failed",
          `Failed to add MapLibre COG layer "${this.layerId}".`,
          { sourceId: this.sourceId, layerId: this.layerId },
          cause,
        );
      }
      return;
    }

    if (!isImageSource(this.ownedSource)) {
      throw renderError("source-drift", "The owned MapLibre COG source cannot update its image.", {
        sourceId: this.sourceId,
      });
    }
    const source = this.ownedSource;
    const updateImage = source.updateImage;
    this.assertMutationCurrent(generation, source);
    try {
      updateImage.call(source, { url, coordinates });
    } catch (cause) {
      throw renderError(
        "map-mutation-failed",
        `Failed to update MapLibre COG source "${this.sourceId}".`,
        { sourceId: this.sourceId },
        cause,
      );
    }
  }

  private captureAddedSource(): void {
    const source = this.map.getSource(this.sourceId);
    if (source !== undefined) {
      this.ownedSource = source;
    }
  }

  private rollbackFirstMount(): void {
    if (this.ownedSource === undefined || this.map.getSource(this.sourceId) !== this.ownedSource) return;
    if (this.map.getLayer(this.layerId) !== undefined) {
      try {
        this.assertOwnedSource();
        this.map.removeLayer(this.layerId);
      } catch {
        return;
      }
    }
    try {
      this.assertOwnedSource();
      this.map.removeSource(this.sourceId);
      this.ownedSource = undefined;
      this.layerMounted = false;
    } catch {
      // The original mutation error is more actionable; dispose retries.
    }
  }

  private removeOwnedObjects(): string[] {
    const errors: string[] = [];
    if (this.ownedSource === undefined) return errors;
    if (this.map.getSource(this.sourceId) !== this.ownedSource) {
      errors.push(`source:${this.sourceId}:identity-changed`);
      return errors;
    }
    if (this.map.getLayer(this.layerId) !== undefined) {
      try {
        this.assertOwnedSource();
        this.map.removeLayer(this.layerId);
        this.layerMounted = false;
      } catch (cause) {
        errors.push(`layer:${this.layerId}:${errorMessage(cause)}`);
      }
    }
    try {
      this.assertOwnedSource();
      this.map.removeSource(this.sourceId);
      this.ownedSource = undefined;
    } catch (cause) {
      errors.push(`source:${this.sourceId}:${errorMessage(cause)}`);
    }
    return errors;
  }

  private assertOwnedSource(): void {
    if (this.ownedSource === undefined || this.map.getSource(this.sourceId) !== this.ownedSource) {
      throw renderError("source-drift", "The MapLibre COG source identity changed.", { sourceId: this.sourceId });
    }
  }

  private assertMutationCurrent(generation: number, expectedSource: unknown): void {
    this.assertCurrent(generation, this.active?.controller.signal);
    const current = this.map.getSource(this.sourceId);
    if (current !== expectedSource) {
      throw renderError("source-drift", "The MapLibre COG source identity changed before mutation.", {
        sourceId: this.sourceId,
      });
    }
  }

  private assertCurrent(generation: number, signal: AbortSignal | undefined): void {
    if (this.disposed || this.lifecycle.signal.aborted || signal?.reason === DISPOSED_RENDER) {
      throw renderError("disposed", "The COG MapLibre mount has been disposed.");
    }
    if (generation !== this.generation || signal?.aborted) {
      throw renderError("obsolete-read", "The COG MapLibre refresh was superseded by a newer viewport.");
    }
  }

  private refreshError(cause: unknown, generation: number, signal: AbortSignal): HonuaCogMapLibreError {
    if (this.disposed || signal.reason === DISPOSED_RENDER || this.lifecycle.signal.aborted) {
      return renderError("disposed", "The COG MapLibre mount has been disposed.", undefined, cause);
    }
    if (generation !== this.generation || signal.reason === OBSOLETE_RENDER) {
      return renderError(
        "obsolete-read",
        "The COG MapLibre refresh was superseded by a newer viewport.",
        undefined,
        cause,
      );
    }
    if (cause instanceof HonuaCogMapLibreError) return cause;
    if (cause instanceof HonuaCogError) {
      if (cause.code === "aborted" || cause.code === "obsolete-read") {
        return renderError("aborted", "The bounded COG render read was aborted.", { causeCode: cause.code }, cause);
      }
      return renderError("render-unavailable", cause.message, { causeCode: cause.code }, cause);
    }
    return renderError("render-unavailable", "The COG MapLibre refresh failed.", undefined, cause);
  }

  private pushDiagnostic(value: Omit<CogMapLibreDiagnostic, "sequence">): void {
    const diagnostic = Object.freeze({ sequence: ++this.diagnosticSequence, ...value });
    this.diagnosticsLog.push(diagnostic);
    if (this.diagnosticsLog.length > this.limits.maxDiagnostics) {
      this.diagnosticsLog = this.diagnosticsLog.slice(-this.limits.maxDiagnostics);
    }
  }

  private attachEvents(): void {
    if (this.eventsAttached || this.disposed) return;
    this.map.on("moveend", this.eventListener);
    this.map.on("resize", this.eventListener);
    this.eventsAttached = true;
  }

  private detachEvents(): void {
    if (!this.eventsAttached) return;
    this.map.off("moveend", this.eventListener);
    this.map.off("resize", this.eventListener);
    this.eventsAttached = false;
  }

  private assertActive(): void {
    if (this.disposed) throw renderError("disposed", "The COG MapLibre mount has been disposed.");
  }
}

/**
 * Mount one accepted S1 COG session as a bounded, viewport-driven MapLibre
 * image source. Browser Canvas and the MapLibre map are resolved only when a
 * refresh renders; importing this module is DOM-neutral.
 */
export function mountStacCogAssetToMapLibre(
  map: StacCogAssetToMapLibreMap,
  session: StacCogAssetSession,
  options: MountStacCogAssetToMapLibreOptions = {},
): MountedStacCogAssetToMapLibre {
  if (!session || typeof session.inspect !== "function" || typeof session.readWindow !== "function") {
    throw renderError("render-unavailable", "An accepted S1 StacCogAssetSession is required.");
  }
  return new StacCogMapLibreMount(map, session, options);
}

function planWindow(
  inspection: CogInspection,
  extent: AssetExtent,
  bands: PlannedBands,
  viewport: CogMapLibreViewport,
  resampling: CogResampling,
  limits: RenderLimits,
): RenderPlan | undefined {
  const viewportExtent = viewportToAssetExtent(viewport, extent.crs);
  const minX = Math.max(extent.minX, viewportExtent.minX);
  const minY = Math.max(extent.minY, viewportExtent.minY);
  const maxX = Math.min(extent.maxX, viewportExtent.maxX);
  const maxY = Math.min(extent.maxY, viewportExtent.maxY);
  if (!(minX < maxX && minY < maxY)) return undefined;

  const x0 = clamp(Math.floor((minX - extent.minX) / inspection.resolution.x), 0, inspection.width - 1);
  const x1 = clamp(Math.ceil((maxX - extent.minX) / inspection.resolution.x), x0 + 1, inspection.width);
  const y0 = clamp(Math.floor((extent.maxY - maxY) / inspection.resolution.y), 0, inspection.height - 1);
  const y1 = clamp(Math.ceil((extent.maxY - minY) / inspection.resolution.y), y0 + 1, inspection.height);
  const nativeWidth = x1 - x0;
  const nativeHeight = y1 - y0;

  const visibleWidthFraction = (maxX - minX) / (viewportExtent.maxX - viewportExtent.minX);
  const visibleHeightFraction = (maxY - minY) / (viewportExtent.maxY - viewportExtent.minY);
  const desiredWidth = Math.min(nativeWidth, Math.max(1, Math.ceil(viewport.canvasWidth * visibleWidthFraction)));
  const desiredHeight = Math.min(nativeHeight, Math.max(1, Math.ceil(viewport.canvasHeight * visibleHeightFraction)));
  const output = boundedOutputDimensions(desiredWidth, desiredHeight, limits);
  const desiredDecimation = Math.max(nativeWidth / output.width, nativeHeight / output.height, 1);
  const overviewDecimation = selectOverview(inspection.overviewDecimations, desiredDecimation);
  const estimatedWidth = Math.ceil(nativeWidth / overviewDecimation);
  const estimatedHeight = Math.ceil(nativeHeight / overviewDecimation);
  const estimatedSourcePixels = estimatedWidth * estimatedHeight;
  if (!Number.isSafeInteger(estimatedSourcePixels) || estimatedSourcePixels > limits.maxSourcePixels) {
    throw renderError(
      "render-overflow",
      `The visible COG window exceeds the ${limits.maxSourcePixels}-pixel overview decode ceiling.`,
      {
        nativeWidth,
        nativeHeight,
        overviewDecimation,
        estimatedSourcePixels,
        maxSourcePixels: limits.maxSourcePixels,
      },
    );
  }

  const windowMinX = extent.minX + x0 * inspection.resolution.x;
  const windowMaxX = extent.minX + x1 * inspection.resolution.x;
  const windowMaxY = extent.maxY - y0 * inspection.resolution.y;
  const windowMinY = extent.maxY - y1 * inspection.resolution.y;
  const topLeft = assetToLngLat(windowMinX, windowMaxY, extent.crs);
  const topRight = assetToLngLat(windowMaxX, windowMaxY, extent.crs);
  const bottomRight = assetToLngLat(windowMaxX, windowMinY, extent.crs);
  const bottomLeft = assetToLngLat(windowMinX, windowMinY, extent.crs);
  const sampling = Object.freeze({
    width: output.width,
    height: output.height,
    resampling,
    overviewDecimation,
  });
  return Object.freeze({
    viewport,
    request: Object.freeze({
      x: x0,
      y: y0,
      width: nativeWidth,
      height: nativeHeight,
      bands: bands.requested,
      sampling,
    }),
    coordinates: Object.freeze([topLeft, topRight, bottomRight, bottomLeft] as const),
    bands,
    estimatedSourcePixels,
  });
}

function validateExtent(inspection: CogInspection): AssetExtent {
  const crs = renderCrs(inspection);
  const footprint = inspection.footprint;
  if (footprint.type !== "Polygon" || footprint.coordinates.length !== 1) {
    throw renderError(
      "unsupported-extent",
      "Direct COG rendering requires one north-up polygon footprint without holes.",
      { footprintType: footprint.type },
    );
  }
  const ring = footprint.coordinates[0]!;
  if (ring.length !== 5 || ring.some((position) => position.length !== 2)) {
    throw renderError("unsupported-extent", "Direct COG rendering requires an axis-aligned four-corner footprint.");
  }
  const xs = ring.slice(0, -1).map((position) => position[0]);
  const ys = ring.slice(0, -1).map((position) => position[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(minX < maxX && minY < maxY)) {
    throw renderError("unsupported-extent", "The COG footprint extent is not finite and positive.");
  }
  const uniqueCorners = new Set(
    ring
      .slice(0, -1)
      .map(
        (position) =>
          `${position[0] === minX ? 0 : position[0] === maxX ? 1 : "x"}:${
            position[1] === minY ? 0 : position[1] === maxY ? 1 : "y"
          }`,
      ),
  );
  if (uniqueCorners.size !== 4 || [...uniqueCorners].some((corner) => corner.includes("x") || corner.includes("y"))) {
    throw renderError("unsupported-extent", "Rotated or sheared COG footprints require an external renderer.");
  }
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index]!;
    const end = ring[index + 1]!;
    const horizontal = start[1] === end[1] && start[0] !== end[0];
    const vertical = start[0] === end[0] && start[1] !== end[1];
    if (!horizontal && !vertical) {
      throw renderError("unsupported-extent", "Self-crossing or diagonal COG footprints require an external renderer.");
    }
  }

  const expectedWidth = inspection.width * inspection.resolution.x;
  const expectedHeight = inspection.height * inspection.resolution.y;
  if (!approximatelyEqual(maxX - minX, expectedWidth) || !approximatelyEqual(maxY - minY, expectedHeight)) {
    throw renderError(
      "unsupported-extent",
      "The COG footprint, dimensions, and pixel resolution do not define one north-up grid.",
      { extentWidth: maxX - minX, extentHeight: maxY - minY, expectedWidth, expectedHeight },
    );
  }
  validateRenderableBounds(minX, minY, maxX, maxY, crs);
  return Object.freeze({ crs, minX, minY, maxX, maxY });
}

function renderCrs(inspection: CogInspection): AssetExtent["crs"] {
  const authority = inspection.crs.authority?.trim().toUpperCase();
  const code = inspection.crs.code?.trim().toUpperCase();
  if (authority === "EPSG" && code === "4326") return "EPSG:4326";
  if (authority === "EPSG" && code === "3857") return "EPSG:3857";
  if (authority === "OGC" && (code === "CRS84" || code === "CRS:84")) return "OGC:CRS84";
  throw renderError(
    "unsupported-crs",
    "Direct COG MapLibre rendering supports only EPSG:4326, OGC:CRS84, and EPSG:3857.",
    { authority: inspection.crs.authority, code: inspection.crs.code },
  );
}

function validateRenderableBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  crs: AssetExtent["crs"],
): void {
  const valid =
    crs === "EPSG:3857"
      ? minX >= -WEB_MERCATOR_MAX && maxX <= WEB_MERCATOR_MAX && minY >= -WEB_MERCATOR_MAX && maxY <= WEB_MERCATOR_MAX
      : minX >= -180 && maxX <= 180 && minY >= -WEB_MERCATOR_MAX_LATITUDE && maxY <= WEB_MERCATOR_MAX_LATITUDE;
  if (!valid) {
    throw renderError("unsupported-extent", "The COG extent exceeds MapLibre Web Mercator render bounds.", { crs });
  }
}

function planBands(bands: readonly CogBand[], requested: CogMapLibreBandMapping | undefined): PlannedBands {
  const byIndex = new Map(bands.map((band) => [band.index, band]));
  const mapping = requested ?? inferBandMapping(bands);
  const colorIndices = mapping.mode === "grayscale" ? [mapping.band] : [mapping.red, mapping.green, mapping.blue];
  const selected = [...colorIndices, ...(mapping.alpha === undefined ? [] : [mapping.alpha])];
  if (
    new Set(selected).size !== selected.length ||
    selected.some((index) => !Number.isSafeInteger(index) || !byIndex.has(index))
  ) {
    throw renderError("unsupported-sample-type", "COG render bands must be unique inspected band indices.", {
      bands: selected,
    });
  }
  const selectedBands = selected.map((index) => byIndex.get(index)!);
  for (const band of selectedBands) {
    if (
      band.dataType !== "uint8" ||
      (band.scale !== undefined && band.scale !== 1) ||
      (band.offset !== undefined && band.offset !== 0)
    ) {
      throw renderError(
        "unsupported-sample-type",
        "Direct COG rendering requires uint8 bands with identity scale and offset.",
        { band: band.index, dataType: band.dataType, scale: band.scale, offset: band.offset },
      );
    }
    if (typeof band.nodata === "string") {
      throw renderError("unsupported-nodata", "String COG nodata values cannot be rendered safely.", {
        band: band.index,
      });
    }
    if (typeof band.nodata === "number" && (!Number.isInteger(band.nodata) || band.nodata < 0 || band.nodata > 255)) {
      throw renderError("unsupported-nodata", "uint8 COG nodata must be an integer from 0 through 255.", {
        band: band.index,
        nodata: band.nodata,
      });
    }
  }
  const colorBands = colorIndices.map((index) => byIndex.get(index)!);
  const numericNoData = colorBands.filter((band) => typeof band.nodata === "number");
  if (numericNoData.length !== 0 && numericNoData.length !== colorBands.length) {
    throw renderError(
      "unsupported-nodata",
      "Every selected color band must expose numeric nodata when any selected band does.",
      { bands: colorIndices },
    );
  }
  return Object.freeze({
    mode: mapping.mode,
    requested: Object.freeze(selected),
    color: Object.freeze(
      colorBands.map((band) =>
        Object.freeze({ band: band.index, ...(typeof band.nodata === "number" ? { nodata: band.nodata } : {}) }),
      ),
    ),
    ...(mapping.alpha !== undefined ? { alpha: mapping.alpha } : {}),
  });
}

function inferBandMapping(bands: readonly CogBand[]): CogMapLibreBandMapping {
  if (bands.length === 1) return Object.freeze({ mode: "grayscale", band: bands[0]!.index });
  const interpretations = new Map<string, number[]>();
  for (const band of bands) {
    const key = band.colorInterpretation?.trim().toLowerCase();
    if (!key) continue;
    const values = interpretations.get(key) ?? [];
    values.push(band.index);
    interpretations.set(key, values);
  }
  const red = singleInterpretation(interpretations, "red");
  const green = singleInterpretation(interpretations, "green");
  const blue = singleInterpretation(interpretations, "blue");
  const alpha = singleInterpretation(interpretations, "alpha");
  if (red !== undefined && green !== undefined && blue !== undefined) {
    return Object.freeze({ mode: "rgb", red, green, blue, ...(alpha !== undefined ? { alpha } : {}) });
  }
  const gray = singleInterpretation(interpretations, "gray") ?? singleInterpretation(interpretations, "grey");
  if (gray !== undefined)
    return Object.freeze({ mode: "grayscale", band: gray, ...(alpha !== undefined ? { alpha } : {}) });
  throw renderError(
    "unsupported-sample-type",
    "Multi-band COG rendering requires explicit bands or exact gray/RGB color interpretations.",
  );
}

function singleInterpretation(values: Map<string, number[]>, name: string): number | undefined {
  const matches = values.get(name);
  if (!matches) return undefined;
  if (matches.length !== 1) {
    throw renderError("unsupported-sample-type", `COG color interpretation "${name}" is ambiguous.`);
  }
  return matches[0];
}

function encodeWindow(
  result: CogWindowResult,
  bands: PlannedBands,
  limits: RenderLimits,
): { readonly url: string; readonly bytes: number } {
  const pixels = result.width * result.height;
  const rgbaBytes = pixels * 4;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels <= 0 ||
    pixels > limits.maxOutputPixels ||
    result.width > limits.maxOutputDimension ||
    result.height > limits.maxOutputDimension ||
    !Number.isSafeInteger(rgbaBytes)
  ) {
    throw renderError("render-overflow", "The decoded COG output exceeds the bounded canvas allocation.", {
      width: result.width,
      height: result.height,
      pixels,
      maxOutputPixels: limits.maxOutputPixels,
      maxOutputDimension: limits.maxOutputDimension,
    });
  }
  const documentRef = globalThis.document;
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw renderError("render-unavailable", "Browser Canvas 2D is required for direct COG MapLibre rendering.");
  }
  const canvas = documentRef.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const context = canvas.getContext("2d");
  if (!context || typeof context.createImageData !== "function" || typeof canvas.toDataURL !== "function") {
    throw renderError("render-unavailable", "Browser Canvas 2D image encoding is unavailable.");
  }
  const imageData = context.createImageData(result.width, result.height);
  if (imageData.data.byteLength !== rgbaBytes) {
    throw renderError("encoding-failed", "Canvas returned an unexpected RGBA allocation size.");
  }
  const values = new Map(result.bands.map((entry) => [entry.band, entry.values]));
  const color = bands.color.map((entry) => ({ ...entry, values: values.get(entry.band) }));
  const alpha = bands.alpha === undefined ? undefined : values.get(bands.alpha);
  if (
    color.some((entry) => !(entry.values instanceof Uint8Array)) ||
    (alpha !== undefined && !(alpha instanceof Uint8Array))
  ) {
    throw renderError("unsupported-sample-type", "The COG decoder did not return uint8 render bands.");
  }
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const target = pixel * 4;
    const nodata = color.every((entry) => entry.nodata !== undefined && entry.values![pixel] === entry.nodata);
    if (bands.mode === "grayscale") {
      const sample = color[0]!.values![pixel]!;
      imageData.data[target] = sample;
      imageData.data[target + 1] = sample;
      imageData.data[target + 2] = sample;
    } else {
      imageData.data[target] = color[0]!.values![pixel]!;
      imageData.data[target + 1] = color[1]!.values![pixel]!;
      imageData.data[target + 2] = color[2]!.values![pixel]!;
    }
    imageData.data[target + 3] = nodata ? 0 : (alpha?.[pixel] ?? 255);
  }
  context.putImageData(imageData, 0, 0);
  let url: string;
  try {
    url = canvas.toDataURL("image/png");
  } catch (cause) {
    throw renderError("encoding-failed", "Canvas failed to encode the bounded COG window as PNG.", undefined, cause);
  }
  if (url === "data:," || !url.startsWith("data:image/png;base64,")) {
    throw renderError("encoding-failed", "Canvas returned no usable PNG for the bounded COG window.");
  }
  const encodedBytes = base64DecodedBytes(url.slice("data:image/png;base64,".length));
  if (encodedBytes > limits.maxEncodedBytes) {
    throw renderError(
      "render-overflow",
      `The encoded COG window exceeds the ${limits.maxEncodedBytes}-byte image ceiling.`,
      { encodedBytes, maxEncodedBytes: limits.maxEncodedBytes },
    );
  }
  return Object.freeze({ url, bytes: encodedBytes });
}

function readViewport(map: StacCogAssetToMapLibreMap): CogMapLibreViewport {
  let bounds: CogMapLibreBoundsLike;
  let canvas: CogMapLibreCanvasLike;
  let zoom: number;
  try {
    bounds = map.getBounds();
    canvas = map.getCanvas();
    zoom = map.getZoom();
  } catch (cause) {
    throw renderError("render-unavailable", "MapLibre viewport state is unavailable.", undefined, cause);
  }
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;
  if (
    ![west, south, east, north, zoom, canvasWidth, canvasHeight].every(Number.isFinite) ||
    !(west < east && south < north) ||
    west < -180 ||
    east > 180 ||
    south < -WEB_MERCATOR_MAX_LATITUDE ||
    north > WEB_MERCATOR_MAX_LATITUDE ||
    !Number.isSafeInteger(canvasWidth) ||
    !Number.isSafeInteger(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    throw renderError(
      "unsupported-extent",
      "Direct COG rendering requires a finite, non-wrapped Web Mercator viewport and positive canvas.",
      { west, south, east, north, zoom, canvasWidth, canvasHeight },
    );
  }
  return Object.freeze({ west, south, east, north, zoom, canvasWidth, canvasHeight });
}

function viewportToAssetExtent(viewport: CogMapLibreViewport, crs: AssetExtent["crs"]): AssetExtent {
  if (crs !== "EPSG:3857") {
    return Object.freeze({ crs, minX: viewport.west, minY: viewport.south, maxX: viewport.east, maxY: viewport.north });
  }
  const southwest = lngLatToMercator(viewport.west, viewport.south);
  const northeast = lngLatToMercator(viewport.east, viewport.north);
  return Object.freeze({ crs, minX: southwest[0], minY: southwest[1], maxX: northeast[0], maxY: northeast[1] });
}

function assetToLngLat(x: number, y: number, crs: AssetExtent["crs"]): readonly [number, number] {
  if (crs !== "EPSG:3857") return Object.freeze([x, y]);
  const longitude = (x / WEB_MERCATOR_MAX) * 180;
  const latitude = (Math.atan(Math.sinh((y / WEB_MERCATOR_MAX) * Math.PI)) * 180) / Math.PI;
  return Object.freeze([longitude, latitude]);
}

function lngLatToMercator(longitude: number, latitude: number): readonly [number, number] {
  const x = (longitude / 180) * WEB_MERCATOR_MAX;
  const y = (Math.log(Math.tan(((90 + latitude) * Math.PI) / 360)) / Math.PI) * WEB_MERCATOR_MAX;
  return Object.freeze([x, y]);
}

function boundedOutputDimensions(
  width: number,
  height: number,
  limits: RenderLimits,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    limits.maxOutputDimension / width,
    limits.maxOutputDimension / height,
    Math.sqrt(limits.maxOutputPixels / (width * height)),
  );
  const outputWidth = Math.max(1, Math.floor(width * scale));
  const outputHeight = Math.max(1, Math.floor(height * scale));
  const pixels = outputWidth * outputHeight;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxOutputPixels) {
    throw renderError("render-overflow", "The COG render target exceeds the output-pixel ceiling.", {
      width: outputWidth,
      height: outputHeight,
      pixels,
      maxOutputPixels: limits.maxOutputPixels,
    });
  }
  return Object.freeze({ width: outputWidth, height: outputHeight });
}

function selectOverview(overviews: readonly number[], desired: number): number {
  let selected = 1;
  for (const overview of overviews) {
    if (overview > desired) break;
    selected = overview;
  }
  return selected;
}

function normalizeOptions(value: MountStacCogAssetToMapLibreOptions): MountStacCogAssetToMapLibreOptions {
  if (!isRecord(value)) {
    throw renderError("render-unavailable", "COG MapLibre mount options must be an object.");
  }
  if (value.resampling !== undefined && value.resampling !== "nearest" && value.resampling !== "bilinear") {
    throw renderError("invalid-window", "COG MapLibre resampling must be nearest or bilinear.");
  }
  if (value.disposeSession !== undefined && typeof value.disposeSession !== "boolean") {
    throw renderError("render-unavailable", "disposeSession must be boolean when supplied.");
  }
  if (value.limits !== undefined && !isRecord(value.limits)) {
    throw renderError("render-overflow", "COG MapLibre render limits must be an object.");
  }
  const paint = cloneRecord(value.paint, "paint");
  const layout = cloneRecord(value.layout, "layout");
  const bands = cloneBandMapping(value.bands);
  return Object.freeze({
    ...(value.sourceId !== undefined ? { sourceId: boundedId(value.sourceId) } : {}),
    ...(value.layerId !== undefined ? { layerId: boundedId(value.layerId) } : {}),
    ...(value.beforeId !== undefined ? { beforeId: boundedId(value.beforeId) } : {}),
    ...(bands ? { bands } : {}),
    ...(value.resampling ? { resampling: value.resampling } : {}),
    ...(paint ? { paint } : {}),
    ...(layout ? { layout } : {}),
    ...(value.limits ? { limits: Object.freeze({ ...value.limits }) } : {}),
    ...(value.disposeSession !== undefined ? { disposeSession: value.disposeSession } : {}),
  });
}

function cloneRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw renderError("render-unavailable", `COG MapLibre ${label} must be an object.`);
  return Object.freeze({ ...value });
}

function cloneBandMapping(value: unknown): CogMapLibreBandMapping | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw renderError("unsupported-sample-type", "COG MapLibre bands must be a grayscale or RGB mapping.");
  }
  if (value.mode === "grayscale") {
    const band = renderBandIndex(value.band, "band");
    const alpha = value.alpha === undefined ? undefined : renderBandIndex(value.alpha, "alpha");
    return Object.freeze({
      mode: "grayscale",
      band,
      ...(alpha !== undefined ? { alpha } : {}),
    });
  }
  if (value.mode === "rgb") {
    const red = renderBandIndex(value.red, "red");
    const green = renderBandIndex(value.green, "green");
    const blue = renderBandIndex(value.blue, "blue");
    const alpha = value.alpha === undefined ? undefined : renderBandIndex(value.alpha, "alpha");
    return Object.freeze({
      mode: "rgb",
      red,
      green,
      blue,
      ...(alpha !== undefined ? { alpha } : {}),
    });
  }
  throw renderError("unsupported-sample-type", "COG MapLibre bands must use grayscale or RGB mode.");
}

function renderBandIndex(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw renderError("unsupported-sample-type", `COG MapLibre ${label} must be a positive band index.`);
  }
  return value as number;
}

function normalizeRenderLimits(options: CogMapLibreRenderLimitOptions = {}): RenderLimits {
  return Object.freeze({
    maxOutputPixels: boundedLimit(
      options.maxOutputPixels,
      DEFAULT_COG_MAPLIBRE_RENDER_LIMITS.maxOutputPixels,
      HARD_RENDER_LIMITS.maxOutputPixels,
      "maxOutputPixels",
    ),
    maxSourcePixels: boundedLimit(
      options.maxSourcePixels,
      DEFAULT_COG_MAPLIBRE_RENDER_LIMITS.maxSourcePixels,
      HARD_RENDER_LIMITS.maxSourcePixels,
      "maxSourcePixels",
    ),
    maxEncodedBytes: boundedLimit(
      options.maxEncodedBytes,
      DEFAULT_COG_MAPLIBRE_RENDER_LIMITS.maxEncodedBytes,
      HARD_RENDER_LIMITS.maxEncodedBytes,
      "maxEncodedBytes",
    ),
    maxOutputDimension: boundedLimit(
      options.maxOutputDimension,
      DEFAULT_COG_MAPLIBRE_RENDER_LIMITS.maxOutputDimension,
      HARD_RENDER_LIMITS.maxOutputDimension,
      "maxOutputDimension",
    ),
    maxDiagnostics: boundedLimit(
      options.maxDiagnostics,
      DEFAULT_COG_MAPLIBRE_RENDER_LIMITS.maxDiagnostics,
      HARD_RENDER_LIMITS.maxDiagnostics,
      "maxDiagnostics",
    ),
  });
}

function boundedLimit(value: number | undefined, fallback: number, hard: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > hard) {
    throw renderError("render-overflow", `${name} must be a positive safe integer no greater than ${hard}.`, {
      option: name,
      value: selected,
      hardMaximum: hard,
    });
  }
  return selected;
}

function validateMap(map: StacCogAssetToMapLibreMap): void {
  const methods = [
    "getSource",
    "addSource",
    "removeSource",
    "getLayer",
    "addLayer",
    "removeLayer",
    "getBounds",
    "getZoom",
    "getCanvas",
    "on",
    "off",
  ] as const;
  if (!map || methods.some((method) => typeof map[method] !== "function")) {
    throw renderError("render-unavailable", "A complete caller-injected MapLibre map is required.");
  }
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    throw renderError("map-conflict", "COG MapLibre ids must be non-empty bounded strings.");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function linkedController(signal: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", abort),
  };
}

function renderError(
  code: CogMapLibreErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): HonuaCogMapLibreError {
  return new HonuaCogMapLibreError(code, message, detail, cause === undefined ? undefined : { cause });
}

function failureStage(code: CogMapLibreErrorCode): CogMapLibreDiagnostic["stage"] {
  if (code === "encoding-failed") return "encode";
  if (code === "map-conflict" || code === "map-mutation-failed" || code === "source-drift") return "map";
  if (code === "aborted" || code === "obsolete-read") return "read";
  return "plan";
}

function isImageSource(value: unknown): value is CogMapLibreImageSourceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CogMapLibreImageSourceLike).updateImage === "function"
  );
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-9);
  return Math.abs(left - right) <= tolerance;
}

function base64DecodedBytes(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw renderError("encoding-failed", "Canvas returned malformed PNG base64 data.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
