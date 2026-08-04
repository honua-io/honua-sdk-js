import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import Locator from "@arcgis/core/tasks/Locator";
import LocatorSearchSource from "@arcgis/core/widgets/Search/LocatorSearchSource";
import Search from "@arcgis/core/widgets/Search";

const parcels = new FeatureLayer({
  url: "https://example.test/rest/services/parcels/FeatureServer/0",
  outFields: ["OBJECTID", "NAME"],
});

const map = new Map({
  basemap: "gray-vector",
  layers: [parcels],
});
const view = new MapView({
  map,
  container: "viewDiv",
  center: [-157.855, 21.308],
  zoom: 12,
});

const locator = new Locator({
  url: "https://example.test/rest/services/World/GeocodeServer",
});

const addressSource = new LocatorSearchSource({
  locator,
  name: "Addresses",
  placeholder: "Find an address",
  maxResults: 5,
});

const search = new Search({
  view,
  sources: [addressSource],
  includeDefaultSources: false,
  popupEnabled: false,
});

view.ui.add(search, "top-right");

export async function findAddress(term) {
  const candidates = await locator.addressToLocations({
    address: { SingleLine: term },
    maxLocations: 5,
    outFields: ["*"],
  });
  return candidates.map((candidate) => ({
    address: candidate.address,
    x: candidate.location.x,
    y: candidate.location.y,
    score: candidate.score,
  }));
}

export async function searchAddress(term) {
  const response = await search.search(term);
  return response.results.map((result) => result.name);
}

export default {
  mapCtor: map.constructor.name,
  viewCtor: view.constructor.name,
  layerCtor: parcels.constructor.name,
  locatorCtor: locator.constructor.name,
  sourceCtor: addressSource.constructor.name,
  searchCtor: search.constructor.name,
  locatorUrl: locator.url,
  sourceName: addressSource.name,
  sourcePlaceholder: addressSource.placeholder,
  sourceCount: search.sources.length,
  uiCount: view.ui.getComponents().length,
  locator,
};
