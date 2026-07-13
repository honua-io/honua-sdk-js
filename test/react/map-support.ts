/**
 * Test doubles for the react bridge-component suites: a recording FakeMap that
 * satisfies the data-to-map bridge's duck-typed `DataToMapLibreMap`, and a
 * controllable contract `Source` whose `queryAll` either resolves immediately
 * or waits for the test to release it. Mirrors the doubles used by
 * `test/data-to-map-bridge.test.ts`.
 */

import type { Query, Result, Source, SourceDescriptor } from "../../src/contract/types.js";
import { capabilities } from "../../src/contract/types.js";
import type { DataToMapLibreMap } from "../../src/map/data-to-map-bridge.js";

type Listener = (...args: unknown[]) => void;

export class FakeGeoJsonSourceHandle {
  data: unknown;
  readonly setDataCalls: unknown[] = [];
  constructor(spec: Record<string, unknown>) {
    Object.assign(this, spec);
    this.data = spec.data;
  }
  setData(data: unknown): void {
    this.data = data;
    this.setDataCalls.push(data);
  }
}

export class FakeMap implements DataToMapLibreMap {
  readonly sources = new Map<string, FakeGeoJsonSourceHandle>();
  readonly layers = new Map<string, Record<string, unknown>>();
  readonly listeners = new Map<string, Set<Listener>>();
  readonly featureStates = new Map<string, Record<string, unknown>>();
  readonly calls: string[] = [];
  readonly paintCalls: Array<{ layerId: string; name: string; value: unknown }> = [];
  readonly layoutCalls: Array<{ layerId: string; name: string; value: unknown }> = [];
  /** Set to false to model a host without property setters (forces remounts). */
  supportsPropertySetters = true;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, spec: unknown): void {
    this.calls.push(`addSource:${id}`);
    this.sources.set(id, new FakeGeoJsonSourceHandle(spec as Record<string, unknown>));
  }
  removeSource(id: string): void {
    this.calls.push(`removeSource:${id}`);
    this.sources.delete(id);
  }
  getLayer(id: string): unknown {
    return this.layers.get(id);
  }
  addLayer(layer: unknown, _beforeId?: string): void {
    const record = layer as Record<string, unknown>;
    this.calls.push(`addLayer:${String(record.id)}`);
    this.layers.set(String(record.id), record);
  }
  removeLayer(id: string): void {
    this.calls.push(`removeLayer:${id}`);
    this.layers.delete(id);
  }
  setPaintProperty(layerId: string, name: string, value: unknown): void {
    if (!this.supportsPropertySetters) throw new Error("setPaintProperty unsupported");
    this.paintCalls.push({ layerId, name, value });
  }
  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    if (!this.supportsPropertySetters) throw new Error("setLayoutProperty unsupported");
    this.layoutCalls.push({ layerId, name, value });
  }
  on(event: string, layerOrHandler: string | Listener, handler?: Listener): void {
    const key = typeof layerOrHandler === "string" ? `${event}:${layerOrHandler}` : event;
    const fn = (typeof layerOrHandler === "function" ? layerOrHandler : handler) as Listener;
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(key, set);
  }
  off(event: string, layerOrHandler: string | Listener, handler?: Listener): void {
    const key = typeof layerOrHandler === "string" ? `${event}:${layerOrHandler}` : event;
    const fn = (typeof layerOrHandler === "function" ? layerOrHandler : handler) as Listener;
    this.listeners.get(key)?.delete(fn);
  }
  emit(event: string, layerId: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(`${event}:${layerId}`) ?? [])]) listener(payload);
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
  setFeatureState(target: { source: string; id: string | number }, state: Record<string, unknown>): void {
    const key = `${target.source}:${target.id}`;
    this.featureStates.set(key, { ...(this.featureStates.get(key) ?? {}), ...state });
  }
  getFeatureState(target: { source: string; id: string | number }): Record<string, unknown> {
    return this.featureStates.get(`${target.source}:${target.id}`) ?? {};
  }
  removeFeatureState(target: { source: string; id: string | number }, key?: string): void {
    if (key === undefined) {
      this.featureStates.delete(`${target.source}:${target.id}`);
      return;
    }
    const state = this.featureStates.get(`${target.source}:${target.id}`);
    if (state) delete state[key];
  }
}

export interface BridgeAttrs {
  OBJECTID: number;
  NAME: string;
}

export function bridgePointFeature(id: number, x = -158 + id * 0.1, y = 21.3): Record<string, unknown> {
  return { attributes: { OBJECTID: id, NAME: `f-${id}` }, geometry: { type: "Point", coordinates: [x, y] } };
}

export function bridgeDescriptor(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://demo.test/rest/services/Parcels/FeatureServer/0" },
    capabilities: capabilities(["query"]),
    schema: { primaryKey: "OBJECTID" },
    ...overrides,
  };
}

/** A `Source` whose queryAll resolves immediately with the given features. */
export interface FakeBridgeSource {
  source: Source<BridgeAttrs>;
  /** Requests seen by queryAll, in order. */
  requests: Array<Query<BridgeAttrs> | undefined>;
  /** Replace the features returned by subsequent queryAll calls. */
  setFeatures(features: Array<Record<string, unknown>>): void;
}

export function fakeBridgeSource(
  features: Array<Record<string, unknown>> = [bridgePointFeature(1), bridgePointFeature(2)],
  descriptor: SourceDescriptor = bridgeDescriptor(),
): FakeBridgeSource {
  let current = features;
  const requests: Array<Query<BridgeAttrs> | undefined> = [];
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    queryAll: async (request?: Query<BridgeAttrs>) => {
      requests.push(request);
      request?.signal?.throwIfAborted();
      return { features: current, exceededTransferLimit: false } as unknown as Result<BridgeAttrs>;
    },
    query: async (request?: Query<BridgeAttrs>) => {
      requests.push(request);
      request?.signal?.throwIfAborted();
      return { features: current, exceededTransferLimit: false } as unknown as Result<BridgeAttrs>;
    },
  } as unknown as Source<BridgeAttrs>;
  return {
    source,
    requests,
    setFeatures(next) {
      current = next;
    },
  };
}
