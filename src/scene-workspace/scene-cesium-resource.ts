import type { SceneProtectedAssetSession } from "./scene-access-session.js";

interface ResourceFetchOptions {
  readonly responseType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface ResourceRequest {
  state: number;
  deferred?: unknown;
  url: string;
  requestFunction: () => Promise<unknown>;
  cancelFunction: (() => void) | undefined;
}

export interface CesiumSceneResource {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly isDataUri: boolean;
  readonly isBlobUri: boolean;
  readonly request: ResourceRequest;
  clone(result?: CesiumSceneResource): CesiumSceneResource;
  fetch(options?: ResourceFetchOptions): Promise<unknown> | undefined;
  fetchImage(options?: Record<string, unknown>): Promise<unknown> | undefined;
}

export interface CesiumSceneResourceRuntime {
  readonly Resource?: {
    new (url: string): CesiumSceneResource;
    readonly isBlobSupported: boolean;
  };
  readonly RequestScheduler?: { request(request: ResourceRequest): Promise<unknown> | undefined };
  readonly RequestState?: { readonly ACTIVE: number; readonly ISSUED: number; readonly UNISSUED: number };
}

interface SceneResourceAccess {
  readonly session: SceneProtectedAssetSession;
  readonly signal?: AbortSignal;
}

/** Keep credentials at the scoped fetch boundary, including for resources derived by Cesium. */
export async function loadWithSceneResource<T>(
  runtime: CesiumSceneResourceRuntime,
  { url, access }: { readonly url: string; readonly access?: SceneResourceAccess },
  load: (resource: string | CesiumSceneResource) => Promise<T>,
): Promise<T> {
  if (!access) return load(url);
  let loading = true;
  const resource = createSceneResource(runtime, url, (url, headers, signal) =>
    access.session.fetchAsset({
      url,
      headers,
      signal: loading && access.signal ? AbortSignal.any([signal, access.signal]) : signal,
    }),
  );
  try {
    return await load(resource);
  } finally {
    loading = false;
  }
}

type FetchSceneResource = (
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<Response>;

function createSceneResource(
  runtime: CesiumSceneResourceRuntime,
  url: string,
  fetchResource: FetchSceneResource,
): CesiumSceneResource {
  const { Resource, RequestScheduler, RequestState } = runtime;
  if (!Resource || !RequestScheduler || !RequestState) {
    throw new Error("The Cesium runtime does not support protected scene resources.");
  }
  const transport = { RequestScheduler, RequestState, fetchResource };
  const isBlobSupported = Resource.isBlobSupported;
  class ProtectedResource extends Resource {
    override clone(result?: CesiumSceneResource): CesiumSceneResource {
      return super.clone(result instanceof ProtectedResource ? result : new ProtectedResource(this.url));
    }

    override fetch(options: ResourceFetchOptions = {}): Promise<unknown> | undefined {
      if (this.isDataUri || this.isBlobUri) return super.fetch(options);
      return scheduleResourceFetch(this, options, transport);
    }

    override fetchImage(options: Record<string, unknown> = {}): Promise<unknown> | undefined {
      if (!isBlobSupported && !this.isDataUri && !this.isBlobUri) {
        throw new Error("Protected scene images require Cesium blob support.");
      }
      return super.fetchImage({ ...options, preferBlob: true });
    }
  }
  return new ProtectedResource(url);
}

function scheduleResourceFetch(
  resource: CesiumSceneResource,
  options: ResourceFetchOptions,
  {
    RequestScheduler,
    RequestState,
    fetchResource,
  }: Required<Pick<CesiumSceneResourceRuntime, "RequestScheduler" | "RequestState">> & {
    readonly fetchResource: FetchSceneResource;
  },
): Promise<unknown> | undefined {
  const { request, url, headers } = resource;
  if (request.state === RequestState.ISSUED || request.state === RequestState.ACTIVE) {
    throw new Error("The protected scene resource is already being fetched.");
  }
  request.state = RequestState.UNISSUED;
  request.deferred = undefined;
  request.url = url;
  request.requestFunction = async () => {
    const controller = new AbortController();
    request.cancelFunction = () => controller.abort();
    const response = await fetchResource(url, { ...headers, ...options.headers }, controller.signal);
    return readResourceResponse(response, options.responseType);
  };
  return RequestScheduler.request(request)?.finally(() => {
    request.cancelFunction = undefined;
  });
}

function readResourceResponse(response: Response, responseType = "text"): Promise<unknown> {
  if (!response.ok) throw new Error(`Protected scene asset request failed with HTTP ${response.status}.`);
  switch (responseType) {
    case "arraybuffer":
      return response.arrayBuffer();
    case "blob":
      return response.blob();
    case "json":
      return response.json();
    case "":
    case "text":
      return response.text();
    default:
      throw new Error(`Unsupported protected scene response type: ${responseType}.`);
  }
}
