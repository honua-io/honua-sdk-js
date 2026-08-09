export interface GeocodingQuickstartConfig {
  readonly honuaBaseUrl: string;
  readonly locatorName: string;
  readonly initialQuery: string;
  readonly maxResults: number;
  readonly mode: "fixture-only";
}

export interface GeocodingAuditRow {
  readonly capability: string;
  readonly interaction: string;
  readonly sdkSurface: string;
  readonly endpoint: string;
  readonly cachePolicy: string;
}

export interface GeocodingPointFeatureProperties {
  readonly kind: "forward";
  readonly index: number;
  readonly address: string;
  readonly subtitle: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly score: number;
}

export interface GeocodingPointFeature {
  readonly type: "Feature";
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: [number, number];
  };
  readonly properties: GeocodingPointFeatureProperties;
}

export interface GeocodingPointFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: GeocodingPointFeature[];
}

export interface GeocodingPolygonFeature {
  readonly type: "Feature";
  readonly geometry: {
    readonly type: "Polygon";
    readonly coordinates: [number, number][][];
  };
  readonly properties: Record<string, string>;
}
