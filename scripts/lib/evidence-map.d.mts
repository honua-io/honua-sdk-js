import type { DataToMapLibreMap } from "@honua/sdk-js/map";

export class EvidenceMap implements DataToMapLibreMap {
  readonly sources: Map<string, Record<string, unknown> & { data?: unknown; setData(data: unknown): void }>;
  readonly layers: Map<string, Record<string, unknown>>;
  getSource(id: string): unknown;
  addSource(id: string, specification: unknown): void;
  removeSource(id: string): void;
  getLayer(id: string): unknown;
  addLayer(layer: unknown): void;
  removeLayer(id: string): void;
}
