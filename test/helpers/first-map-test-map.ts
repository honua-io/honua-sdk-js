import type { MapLibreRendererMap } from "@honua/sdk-js/runtime";

export class FirstMapTestMap implements MapLibreRendererMap {
  readonly sources = new Map<string, unknown>();
  readonly layers = new Map<string, unknown>();
  removeCount = 0;

  loaded(): boolean {
    return true;
  }

  isStyleLoaded(): boolean {
    return true;
  }

  getStyle(): unknown {
    return { version: 8, sources: Object.fromEntries(this.sources), layers: [...this.layers.values()] };
  }

  getSource(id: string): unknown {
    return this.sources.get(id);
  }

  addSource(id: string, source: unknown): void {
    if ((source as { readonly type?: unknown } | null)?.type !== "geojson") {
      this.sources.set(id, source);
      return;
    }
    const handle = {
      ...(source as Readonly<Record<string, unknown>>),
      data: (source as { readonly data?: unknown }).data,
      setData(data: unknown) {
        handle.data = data;
      },
    };
    this.sources.set(id, handle);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getLayer(id: string): unknown {
    return this.layers.get(id);
  }

  addLayer(layer: unknown): void {
    this.layers.set(String((layer as { readonly id: unknown }).id), layer);
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
  }

  once(_event: string, listener: () => void): void {
    queueMicrotask(listener);
  }

  off(): void {}

  triggerRepaint(): void {}

  remove(): void {
    this.removeCount += 1;
  }
}
