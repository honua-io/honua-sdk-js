import type { StacAssetCandidate } from "../connect-stac-static.js";
import { HonuaCogError } from "./errors.js";
import { CogRangeTransport, normalizeCogTransferLimits } from "./range-transport.js";
import type {
  CogDecodedMetadata,
  CogDecoder,
  CogInspection,
  CogOperationOptions,
  CogProvenance,
  CogTransferLedger,
  CogWindowRequest,
  CogWindowResult,
  OpenStacCogAssetOptions,
} from "./types.js";
import {
  normalizeCogMetadata,
  normalizeDecodedWindow,
  normalizeWindowRequest,
  validateCogCandidate,
} from "./validation.js";

const DISPOSE_REASON = Symbol("honua-cog-disposed");
const OBSOLETE_REASON = Symbol("honua-cog-obsolete-read");

interface ActiveWindow {
  readonly generation: number;
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

/**
 * Lazy direct-COG session created from an evidence-classified static STAC
 * asset. The injected decoder never receives an unbounded fetch function.
 */
export class StacCogAssetSession {
  readonly assetUrl: string;
  readonly limits: ReturnType<typeof normalizeCogTransferLimits>;
  private readonly candidate: ReturnType<typeof validateCogCandidate>;
  private readonly decoderFactory: OpenStacCogAssetOptions["decoderFactory"];
  private readonly lifecycle = new AbortController();
  private readonly transport: CogRangeTransport;
  private readonly disposedDecoders = new WeakSet<object>();
  private decoder: CogDecoder | undefined;
  private decoderPromise: Promise<CogDecoder> | undefined;
  private metadata: ReturnType<typeof normalizeCogMetadata> | undefined;
  private inspectionPromise: Promise<ReturnType<typeof normalizeCogMetadata>> | undefined;
  private activeWindow: ActiveWindow | undefined;
  private windowGeneration = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(candidate: StacAssetCandidate, options: OpenStacCogAssetOptions) {
    // Candidate validation intentionally precedes every factory/fetch side effect.
    this.candidate = validateCogCandidate(candidate);
    if (!options || typeof options.decoderFactory !== "function") {
      throw new HonuaCogError("decoder-failed", "A caller-injected COG decoder factory is required.");
    }
    const fetchFn = options.fetchFn ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      throw new HonuaCogError("cors-unavailable", "No Fetch implementation is available for bounded COG ranges.");
    }
    this.assetUrl = this.candidate.assetUrl;
    this.decoderFactory = options.decoderFactory;
    this.limits = normalizeCogTransferLimits(options.limits);
    this.transport = new CogRangeTransport(this.assetUrl, fetchFn, this.limits);
  }

  /** Inspect bounded COG metadata. Decoder and network work start lazily here. */
  async inspect(options: CogOperationOptions = {}): Promise<CogInspection> {
    this.assertActive();
    if (this.metadata) return this.inspectionSnapshot(this.metadata);

    let retriedAbortedSharedInspection = false;
    while (!this.metadata) {
      this.assertActive();
      const current = this.inspectionPromise ?? this.startInspection(options.signal);
      try {
        const metadata = await awaitWithSignal(current, options.signal);
        return this.inspectionSnapshot(metadata);
      } catch (cause) {
        if (
          !retriedAbortedSharedInspection &&
          !options.signal?.aborted &&
          !this.lifecycle.signal.aborted &&
          cause instanceof HonuaCogError &&
          cause.code === "aborted"
        ) {
          retriedAbortedSharedInspection = true;
          await Promise.resolve();
          continue;
        }
        throw this.operationError(cause, options.signal);
      }
    }
    return this.inspectionSnapshot(this.metadata);
  }

  /**
   * Decode one bounded pixel window. Starting a new window makes the previous
   * one obsolete and aborts its range reader.
   */
  async readWindow(request: CogWindowRequest, options: CogOperationOptions = {}): Promise<CogWindowResult> {
    this.assertActive();
    this.activeWindow?.controller.abort(OBSOLETE_REASON);
    this.activeWindow?.cleanup();

    const generation = ++this.windowGeneration;
    const linked = linkedController(this.lifecycle.signal, options.signal);
    const active: ActiveWindow = { generation, controller: linked.controller, cleanup: linked.cleanup };
    this.activeWindow = active;

    try {
      await this.inspect({ signal: linked.controller.signal });
      if (linked.controller.signal.aborted || this.activeWindow?.generation !== generation) {
        throw this.operationError(
          new HonuaCogError("aborted", "The COG window read was aborted."),
          linked.controller.signal,
        );
      }
      const metadata = this.metadata;
      const decoder = this.decoder;
      if (!metadata || !decoder) {
        throw new HonuaCogError("decoder-failed", "The COG decoder did not remain available after inspection.");
      }
      const normalizedRequest = normalizeWindowRequest(request, metadata, this.limits);
      const decodedPromise = Promise.resolve(
        decoder.readWindow(normalizedRequest, {
          signal: linked.controller.signal,
          readRange: this.transport.reader("window", linked.controller.signal),
          metadata,
        }),
      );
      const decoded = await awaitWithSignal(decodedPromise, linked.controller.signal);
      if (linked.controller.signal.aborted || this.activeWindow?.generation !== generation) {
        throw this.operationError(
          new HonuaCogError("aborted", "The COG window read was aborted."),
          linked.controller.signal,
        );
      }
      const bands = normalizeDecodedWindow(decoded, normalizedRequest, metadata, this.limits);
      return Object.freeze({
        window: normalizedRequest,
        width: normalizedRequest.sampling?.width ?? normalizedRequest.width,
        height: normalizedRequest.sampling?.height ?? normalizedRequest.height,
        bands,
        provenance: this.provenance(),
        transfer: this.transport.snapshot(),
      });
    } catch (cause) {
      throw this.operationError(cause, linked.controller.signal);
    } finally {
      if (this.activeWindow?.generation === generation) this.activeWindow = undefined;
      linked.cleanup();
    }
  }

  /** Current deterministic range/byte evidence, including rejected responses. */
  transfer(): CogTransferLedger {
    return this.transport.snapshot();
  }

  /** Abort in-flight work and release the injected decoder. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycle.abort(DISPOSE_REASON);
    this.activeWindow?.controller.abort(DISPOSE_REASON);
    this.activeWindow?.cleanup();
    this.activeWindow = undefined;
    const ready = this.decoder;
    const pending = this.decoderPromise;
    this.decoder = undefined;
    this.decoderPromise = undefined;
    this.metadata = undefined;
    this.inspectionPromise = undefined;
    this.disposePromise = (async () => {
      if (ready) await this.disposeDecoder(ready);
      if (pending) void pending.then((decoder) => this.disposeDecoder(decoder)).catch(() => undefined);
    })();
    await this.disposePromise;
  }

  private startInspection(signal: AbortSignal | undefined): Promise<ReturnType<typeof normalizeCogMetadata>> {
    const linked = linkedController(this.lifecycle.signal, signal);
    const promise = this.runInspection(linked.controller.signal)
      .then((metadata) => {
        if (linked.controller.signal.aborted) throw abortedError();
        this.metadata = metadata;
        return metadata;
      })
      .finally(() => {
        linked.cleanup();
        if (this.inspectionPromise === promise) this.inspectionPromise = undefined;
      });
    // Consumers can abort their await while a decoder ignores its signal. Keep
    // a rejection handler attached so that late completion cannot leak.
    void promise.catch(() => undefined);
    this.inspectionPromise = promise;
    return promise;
  }

  private async runInspection(signal: AbortSignal): Promise<ReturnType<typeof normalizeCogMetadata>> {
    const decoder = await this.ensureDecoder(signal);
    let decoded: CogDecodedMetadata;
    try {
      decoded = await awaitWithSignal(
        Promise.resolve(
          decoder.inspect({
            signal,
            readRange: this.transport.reader("metadata", signal),
          }),
        ),
        signal,
      );
    } catch (cause) {
      if (signal.aborted || isAbortLike(cause)) throw abortedError(cause);
      if (cause instanceof HonuaCogError) throw cause;
      throw new HonuaCogError("decoder-failed", "The injected COG decoder failed during inspection.", { cause });
    }
    if (signal.aborted) throw abortedError();
    return normalizeCogMetadata(decoded);
  }

  private async ensureDecoder(signal: AbortSignal): Promise<CogDecoder> {
    if (this.decoder) return this.decoder;
    if (this.decoderPromise) return awaitWithSignal(this.decoderPromise, signal);

    const candidate = Promise.resolve().then(() =>
      this.decoderFactory({
        assetUrl: this.assetUrl,
        // Factory lifetime is session-scoped. Per-operation cancellation is
        // supplied to inspect/readWindow; an operation-aborted late factory is
        // closed when it settles instead of poisoning a reusable decoder.
        signal: this.lifecycle.signal,
      }),
    );
    const normalized = candidate.then((decoder) => {
      if (!decoder || typeof decoder.inspect !== "function" || typeof decoder.readWindow !== "function") {
        throw new HonuaCogError(
          "decoder-failed",
          "The injected COG decoder must implement inspect() and readWindow().",
        );
      }
      if (this.disposed || signal.aborted || this.lifecycle.signal.aborted) {
        void this.disposeDecoder(decoder);
        throw abortedError();
      }
      this.decoder = decoder;
      return decoder;
    });
    this.decoderPromise = normalized;
    void normalized.catch(() => undefined);
    try {
      return await awaitWithSignal(normalized, signal);
    } catch (cause) {
      if (this.decoderPromise === normalized) this.decoderPromise = undefined;
      void candidate.then((decoder) => this.disposeDecoder(decoder)).catch(() => undefined);
      if (signal.aborted || isAbortLike(cause)) throw abortedError(cause);
      if (cause instanceof HonuaCogError) throw cause;
      throw new HonuaCogError("decoder-failed", "The injected COG decoder factory failed.", { cause });
    }
  }

  private inspectionSnapshot(metadata: ReturnType<typeof normalizeCogMetadata>): CogInspection {
    return Object.freeze({
      format: "cog",
      width: metadata.width,
      height: metadata.height,
      crs: metadata.crs,
      bands: metadata.bands,
      resolution: metadata.resolution,
      footprint: metadata.footprint,
      overviewDecimations: metadata.overviewDecimations ?? Object.freeze([]),
      provenance: this.provenance(),
      transfer: this.transport.snapshot(),
    });
  }

  private provenance(): CogProvenance {
    const validator = this.transport.validator();
    return Object.freeze({
      stac: this.candidate.provenance,
      ...(validator ? { assetValidator: validator } : {}),
    });
  }

  private operationError(cause: unknown, signal: AbortSignal | undefined): HonuaCogError {
    if (this.disposed || signal?.reason === DISPOSE_REASON || this.lifecycle.signal.reason === DISPOSE_REASON) {
      return new HonuaCogError("disposed", "The COG asset session has been disposed.", cause ? { cause } : undefined);
    }
    if (signal?.reason === OBSOLETE_REASON) {
      return new HonuaCogError(
        "obsolete-read",
        "The COG window read was superseded by a newer read.",
        cause ? { cause } : undefined,
      );
    }
    if (signal?.aborted || isAbortLike(cause)) {
      return new HonuaCogError("aborted", "The COG operation was aborted.", cause ? { cause } : undefined);
    }
    if (cause instanceof HonuaCogError) return cause;
    return new HonuaCogError("decoder-failed", "The injected COG decoder failed.", { cause });
  }

  private assertActive(): void {
    if (this.disposed) throw new HonuaCogError("disposed", "The COG asset session has been disposed.");
  }

  private async disposeDecoder(decoder: CogDecoder): Promise<void> {
    if (this.disposedDecoders.has(decoder)) return;
    this.disposedDecoders.add(decoder);
    await decoder.dispose?.();
  }
}

/** Validate a #552 static-STAC candidate and create a lazy direct-COG session. */
export function openStacCogAsset(candidate: StacAssetCandidate, options: OpenStacCogAssetOptions): StacCogAssetSession {
  return new StacCogAssetSession(candidate, options);
}

function linkedController(...signals: Array<AbortSignal | undefined>): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    controller,
    cleanup: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortedError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortedError());
        else resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function abortedError(cause?: unknown): HonuaCogError {
  return new HonuaCogError("aborted", "The COG operation was aborted.", cause ? { cause } : undefined);
}

function isAbortLike(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError") ||
    (cause instanceof HonuaCogError && cause.code === "aborted")
  );
}
