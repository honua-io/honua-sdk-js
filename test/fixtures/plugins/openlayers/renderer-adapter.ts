import { executeQueryPlan } from "../../../../src/query-planner/executor.js";
import type {
  RendererAdapter,
  RendererDiagnostic,
  RendererMountRequest,
  RendererOwnership,
  RendererSession,
  RendererTarget,
} from "../../../../src/kernel/renderer.js";
import { classifyOpenLayersCrsFidelity } from "./crs-fidelity.js";
import { type FakeOlLayer, type FakeOlMap, type FakeOpenLayersPeer, isFakeOlMap } from "./fake-ol.js";

/** Stable identifier this external-style plugin registers with the public renderer seam. */
export const OPENLAYERS_RENDERER_KIND = "org.example.honua.openlayers" as const;
export type OpenLayersRendererKind = typeof OPENLAYERS_RENDERER_KIND;

export type OpenLayersRendererErrorCode =
  | "invalid-options"
  | "crs-unsupported"
  | "view-projection-mismatch"
  | "source-conflict"
  | "map-mutation-failed"
  | "aborted"
  | "disposed";

/**
 * Plain, external-style plugin error. It intentionally does not extend the
 * SDK's migrated `HonuaSdkError` leaf registry: a third-party renderer plugin
 * outside SDK core owns its own diagnostics vocabulary rather than claiming a
 * core error domain.
 */
export class OpenLayersRendererError extends Error {
  public readonly code: OpenLayersRendererErrorCode;
  public readonly detail?: Readonly<Record<string, unknown>>;

  public constructor(
    code: OpenLayersRendererErrorCode,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenLayersRendererError";
    this.code = code;
    this.detail = detail;
  }
}

export interface OpenLayersRendererOptions {
  /** Target view CRS, e.g. a non-Web-Mercator authority code such as "EPSG:3035". Required: never defaulted. */
  readonly projection: string;
  readonly resource: "vector" | "raster";
  /** Required when `resource` is "raster"; a `{z}/{x}/{y}`-style tile template. */
  readonly tileUrlTemplate?: string;
  readonly center?: readonly [number, number];
  readonly zoom?: number;
}

function isMapHost(target: RendererTarget): target is FakeOlMap {
  return isFakeOlMap(target);
}

function honuaLayerId(sourceId: string): string {
  return `honua:${sourceId}`;
}

/**
 * Create an executable OpenLayers-shaped renderer adapter without importing
 * `ol`. `peer` is retained only on this adapter instance, mirroring how a real
 * integration would inject the `ol` module surface as an optional peer.
 */
export function openLayersRenderer(
  peer: FakeOpenLayersPeer,
): RendererAdapter<OpenLayersRendererKind, FakeOlMap, OpenLayersRendererOptions> {
  return Object.freeze({
    kind: OPENLAYERS_RENDERER_KIND,
    environments: Object.freeze(["browser" as const]),
    peer,
    defaultOwnership(target: RendererTarget): RendererOwnership {
      return isMapHost(target) ? "borrowed" : "owned";
    },
    async mount<T>(
      target: RendererTarget,
      request: RendererMountRequest<T, OpenLayersRendererOptions>,
    ): Promise<RendererSession<FakeOlMap>> {
      const options = request.rendererOptions;
      if (!options || typeof options.projection !== "string" || options.projection.length === 0) {
        throw new OpenLayersRendererError(
          "invalid-options",
          "OpenLayers mount requires rendererOptions.projection.",
        );
      }
      if (options.resource === "raster" && !options.tileUrlTemplate) {
        throw new OpenLayersRendererError(
          "invalid-options",
          "A raster/tiled OpenLayers mount requires rendererOptions.tileUrlTemplate.",
        );
      }
      if (request.signal.aborted) {
        throw new OpenLayersRendererError("aborted", "OpenLayers mount was aborted before any host mutation.");
      }

      // Fail closed on an unrecognized CRS instead of silently defaulting to
      // Web Mercator: unsupported must never look like a plausible mount.
      const fidelity = classifyOpenLayersCrsFidelity(peer.projections, options.projection);
      if (fidelity.fidelity === "unsupported") {
        throw new OpenLayersRendererError(
          "crs-unsupported",
          `Projection ${options.projection} is not registered with this OpenLayers peer.`,
          { projection: options.projection },
        );
      }

      const owned = !isMapHost(target);
      let map: FakeOlMap;
      if (owned) {
        const view = new peer.View({
          projection: options.projection,
          ...(options.center === undefined ? {} : { center: options.center }),
          ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
        });
        map = new peer.Map({ view, target });
      } else {
        map = target as FakeOlMap;
        const currentCode = map.getView().getProjection().getCode();
        if (currentCode !== options.projection) {
          throw new OpenLayersRendererError(
            "view-projection-mismatch",
            `Borrowed map view is ${currentCode}; requested mount projection is ${options.projection}.`,
            { current: currentCode, requested: options.projection },
          );
        }
      }

      const layerId = honuaLayerId(String(request.source.descriptor.id));
      if (map.getLayerById(layerId)) {
        if (owned) map.dispose();
        throw new OpenLayersRendererError(
          "source-conflict",
          `A layer named ${layerId} already exists on this map.`,
          { layerId },
        );
      }

      let layer: FakeOlLayer;
      try {
        if (options.resource === "vector") {
          const plan = request.queryPlan ?? (await request.planQuery());
          const execution = await executeQueryPlan(plan, request.source, request.execution);
          layer = { id: layerId, kind: "vector", honuaOwned: true, data: execution.result.features };
        } else {
          layer = {
            id: layerId,
            kind: "tile",
            honuaOwned: true,
            data: { urlTemplate: options.tileUrlTemplate },
          };
        }
      } catch (error) {
        // Planning/execution failures keep their own SDK error identity (the
        // query planner's own stable codes); only host mutation failures below
        // are re-labeled as this adapter's own diagnostics.
        if (owned) map.dispose();
        throw error;
      }

      try {
        map.addLayer(layer);
      } catch (error) {
        const retained = map.getLayerById(layerId);
        if (retained) map.removeLayer(retained);
        if (owned) map.dispose();
        throw new OpenLayersRendererError(
          "map-mutation-failed",
          "The OpenLayers host rejected the mounted layer.",
          { layerId },
          { cause: error },
        );
      }

      const diagnostics: readonly RendererDiagnostic[] = Object.freeze([
        {
          code: `crs-fidelity-${fidelity.fidelity}`,
          severity: fidelity.fidelity === "approximate" ? ("warning" as const) : ("info" as const),
          message:
            fidelity.accuracyMeters === undefined
              ? `Projection ${fidelity.projection} is ${fidelity.fidelity}.`
              : `Projection ${fidelity.projection} is ${fidelity.fidelity} (~${fidelity.accuracyMeters}m accuracy).`,
          strategy: options.resource,
        },
      ]);

      let disposed = false;
      const rollbackMount = (): void => {
        const retained = map.getLayerById(layerId);
        if (retained) map.removeLayer(retained);
        if (owned && !map.disposed) map.dispose();
      };

      const ready = new Promise<void>((resolve, reject) => {
        if (request.signal.aborted) {
          rollbackMount();
          reject(new OpenLayersRendererError("aborted", "OpenLayers mount was aborted before the first frame."));
          return;
        }
        const onAbort = (): void => {
          map.un("rendercomplete", onFrame);
          rollbackMount();
          reject(new OpenLayersRendererError("aborted", "OpenLayers mount was aborted before the first frame."));
        };
        const onFrame = (): void => {
          request.signal.removeEventListener("abort", onAbort);
          resolve();
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        map.once("rendercomplete", onFrame);
        if (owned) queueMicrotask(() => map.renderSync());
      });

      return {
        raw: map,
        ready,
        diagnostics,
        async refresh(refreshOptions): Promise<void> {
          if (disposed) throw new OpenLayersRendererError("disposed", "Cannot refresh a disposed OpenLayers mount.");
          if (options.resource !== "vector") return;
          const plan = await request.planQuery();
          const execution = await executeQueryPlan(plan, request.source, {
            ...request.execution,
            ...(refreshOptions?.signal === undefined ? {} : { signal: refreshOptions.signal }),
          });
          const current = map.getLayerById(layerId);
          if (current) current.data = execution.result.features;
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          const retained = map.getLayerById(layerId);
          if (retained) map.removeLayer(retained);
          if (owned && !map.disposed) map.dispose();
        },
      };
    },
  });
}
