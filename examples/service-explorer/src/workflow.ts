import { HonuaClient } from "@honua/sdk-js/honua";

import { type LoadServiceExplorerDatasetOptions, loadServiceExplorerDataset } from "./data.js";
import type { ServiceExplorerConfig, ServiceExplorerDataset } from "./types.js";

function abortableFetch(fetchFn: typeof fetch, signal: AbortSignal | undefined): typeof fetch {
  return (input, init = {}) => {
    const requestSignal = init.signal;
    const combined =
      signal && requestSignal && requestSignal !== signal
        ? AbortSignal.any([signal, requestSignal])
        : (signal ?? requestSignal);
    return fetchFn(input, { ...init, ...(combined ? { signal: combined } : {}) });
  };
}

/**
 * Copyable public-SDK workflow. Presentation stays in main.ts; this module owns
 * the HonuaClient boundary and injects it into the sample's fixture/cloud data policy.
 */
export async function runServiceExplorerWorkflow(
  config: ServiceExplorerConfig,
  options: Omit<LoadServiceExplorerDatasetOptions, "client"> = {},
): Promise<ServiceExplorerDataset> {
  options.signal?.throwIfAborted();
  const fetchFn = abortableFetch(options.fetchFn ?? globalThis.fetch.bind(globalThis), options.signal);
  const client = new HonuaClient({
    baseUrl: config.honuaBaseUrl,
    apiKey: config.apiKey,
    bearerToken: config.bearerToken,
    fetchFn,
  });
  return loadServiceExplorerDataset(config, { ...options, fetchFn, client });
}
