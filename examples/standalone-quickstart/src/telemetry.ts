// Minimal browser-inspectable runtime state, mirroring the other examples'
// `window.__HONUA_*_RUNTIME__` convention so the Playwright smoke can assert on
// it without scraping the DOM.

export interface StandaloneRuntimeState {
  ready: boolean;
  mapReady: boolean;
  featureCount: number;
  compatFeatureCount: number;
  layerName?: string;
  geometryType?: string;
  layerIds: string[];
  usedServer: boolean;
  disposed?: boolean;
  error?: string;
}

declare global {
  interface Window {
    __HONUA_STANDALONE_RUNTIME__?: StandaloneRuntimeState;
    __HONUA_STANDALONE_DISPOSE__?: () => Promise<void>;
  }
}

export function getRuntimeState(): StandaloneRuntimeState {
  const target = window as Window;
  target.__HONUA_STANDALONE_RUNTIME__ ??= {
    ready: false,
    mapReady: false,
    featureCount: 0,
    compatFeatureCount: 0,
    layerIds: [],
    usedServer: false,
  };
  return target.__HONUA_STANDALONE_RUNTIME__;
}

export function patchRuntimeState(patch: Partial<StandaloneRuntimeState>): void {
  Object.assign(getRuntimeState(), patch);
}
