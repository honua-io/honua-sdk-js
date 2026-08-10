import featureCollectionUrl from "../../../samples/fixtures/first-map/v2/features.json?url";
import layerDefinitionUrl from "../../../samples/fixtures/first-map/v2/layer.json?url&no-inline";

const jsonResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const loadFixture = (url: string): (() => Promise<string>) => {
  let body: Promise<string> | undefined;
  return () => {
    if (!body) {
      body = fetch(url).then((response) => {
        if (!response.ok) throw new Error(`First Map fixture asset failed with HTTP ${response.status}.`);
        return response.text();
      });
    }
    return body;
  };
};

export function createFirstMapFixtureFetch(endpoint: string): typeof fetch {
  const layerUrl = new URL(endpoint);
  const layerPath = layerUrl.pathname.replace(/\/$/, "");
  const loadLayer = loadFixture(layerDefinitionUrl);
  const loadFeatures = loadFixture(featureCollectionUrl);

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === layerUrl.origin && url.pathname.replace(/\/$/, "") === layerPath) {
      return jsonResponse(await loadLayer());
    }
    if (url.origin === layerUrl.origin && url.pathname.replace(/\/$/, "") === `${layerPath}/query`) {
      return jsonResponse(await loadFeatures());
    }
    throw new Error(`First Map fixture rejected an unexpected SDK request: ${url.origin}${url.pathname}`);
  };
}
