import featureCollectionUrl from "../../../samples/fixtures/first-map/v2/features.json?url";
import layerDefinitionUrl from "../../../samples/fixtures/first-map/v2/layer.json?url&no-inline";
import ogcApiDefinitionUrl from "../../../samples/fixtures/first-map/v2/ogc-api-definition.json?url&no-inline";
import ogcCollectionUrl from "../../../samples/fixtures/first-map/v2/ogc-collection.json?url&no-inline";
import ogcConformanceUrl from "../../../samples/fixtures/first-map/v2/ogc-conformance.json?url&no-inline";
import ogcItemsUrl from "../../../samples/fixtures/first-map/v2/ogc-items.json?url&no-inline";
import ogcLandingUrl from "../../../samples/fixtures/first-map/v2/ogc-landing.json?url&no-inline";

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
  const loadOgcLanding = loadFixture(ogcLandingUrl);
  const loadOgcApiDefinition = loadFixture(ogcApiDefinitionUrl);
  const loadOgcConformance = loadFixture(ogcConformanceUrl);
  const loadOgcCollection = loadFixture(ogcCollectionUrl);
  const loadOgcItems = loadFixture(ogcItemsUrl);
  const collectionMarker = "/collections/";
  const collectionMarkerIndex = layerPath.indexOf(collectionMarker);
  const ogcCollectionPath = collectionMarkerIndex >= 0 ? layerPath : undefined;
  const ogcRootPath = ogcCollectionPath?.slice(0, collectionMarkerIndex);
  const ogcCollectionId = ogcCollectionPath?.slice(collectionMarkerIndex + collectionMarker.length);
  const ogcRootAliases = ogcRootPath ? new Set([ogcRootPath, "/ogc/features"]) : undefined;

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "");
    if (url.origin === layerUrl.origin && pathname === layerPath && !ogcRootPath) {
      return jsonResponse(await loadLayer());
    }
    if (url.origin === layerUrl.origin && pathname === `${layerPath}/query` && !ogcRootPath) {
      return jsonResponse(await loadFeatures());
    }
    if (url.origin === layerUrl.origin && ogcRootAliases && ogcCollectionId) {
      for (const rootPath of ogcRootAliases) {
        if (pathname === rootPath) return jsonResponse(await loadOgcLanding());
        if (pathname === `${rootPath}/api`) return jsonResponse(await loadOgcApiDefinition());
        if (pathname === `${rootPath}/conformance`) return jsonResponse(await loadOgcConformance());
        if (pathname === `${rootPath}/collections`) {
          const collection = JSON.parse(await loadOgcCollection()) as unknown;
          return jsonResponse(JSON.stringify({ collections: [collection] }));
        }
        if (pathname === `${rootPath}/collections/${ogcCollectionId}`) {
          return jsonResponse(await loadOgcCollection());
        }
        if (pathname === `${rootPath}/collections/${ogcCollectionId}/items`) {
          return jsonResponse(await loadOgcItems());
        }
      }
    }
    throw new Error(`First Map fixture rejected an unexpected SDK request: ${url.origin}${url.pathname}`);
  };
}
