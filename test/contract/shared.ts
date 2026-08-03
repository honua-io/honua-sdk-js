/**
 * Shared fixtures for the conformance suite. The mocks here construct a
 * `HonuaClient` whose `fetchFn` is a pluggable handler keyed by URL path.
 * Conformance tests dispatch the same canonical `Query` against each
 * adapter and assert against the canonical `Result` envelope.
 */

import { HonuaClient } from "../../src/core/client.js";
import type { HonuaOgcFeatureCollectionResponse, HonuaTypedQueryResponse } from "../../src/core/types.js";

export type MockResponder = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface MockClientOptions {
  /** Map of substring matchers → responder. First match wins. */
  routes: Array<[string | RegExp, MockResponder]>;
  /** Fallback responder; defaults to 404. */
  fallback?: MockResponder;
}

export function makeMockClient(options: MockClientOptions): HonuaClient {
  const fallback: MockResponder = options.fallback ?? (() => new Response("not found", { status: 404 }));
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      for (const [matcher, responder] of options.routes) {
        const matched =
          typeof matcher === "string"
            ? url.pathname.includes(matcher) || url.href.includes(matcher)
            : matcher.test(url.href);
        if (matched) return responder(url, init);
      }
      return fallback(url, init);
    },
  });
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

// ── Sample features ───────────────────────────────────────────

export interface ParcelAttrs {
  OBJECTID: number;
  STATE: string;
  ACRES: number;
}

export const PARCEL_FEATURES: Array<{ attributes: ParcelAttrs; geometry: { x: number; y: number } }> = [
  { attributes: { OBJECTID: 1, STATE: "CA", ACRES: 12 }, geometry: { x: -120, y: 38 } },
  { attributes: { OBJECTID: 2, STATE: "CA", ACRES: 7.5 }, geometry: { x: -121, y: 37 } },
  { attributes: { OBJECTID: 3, STATE: "OR", ACRES: 20 }, geometry: { x: -123, y: 45 } },
];

export function geoservicesQueryResponse(
  features = PARCEL_FEATURES,
  exceeded = false,
): HonuaTypedQueryResponse<ParcelAttrs> {
  return {
    features,
    exceededTransferLimit: exceeded,
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "STATE", type: "esriFieldTypeString" },
      { name: "ACRES", type: "esriFieldTypeDouble" },
    ],
  };
}

export function geoservicesAggregateResponse(): HonuaTypedQueryResponse<{ STATE: string; SUM_ACRES: number }> {
  return {
    features: [
      { attributes: { STATE: "CA", SUM_ACRES: 19.5 }, geometry: null },
      { attributes: { STATE: "OR", SUM_ACRES: 20 }, geometry: null },
    ],
    exceededTransferLimit: false,
  };
}

export function geoservicesExtentResponse(): {
  extent: { xmin: number; ymin: number; xmax: number; ymax: number };
  count: number;
} {
  return {
    extent: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
    count: PARCEL_FEATURES.length,
  };
}

export function ogcCollectionMetadata(): {
  id: string;
  extent: { spatial: { bbox: number[][] } };
} {
  return {
    id: "parcels",
    extent: { spatial: { bbox: [[-123, 37, -120, 45]] } },
  };
}

export function ogcItemsResponse(features = PARCEL_FEATURES): HonuaOgcFeatureCollectionResponse {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature" as const,
      id: f.attributes.OBJECTID,
      properties: { ...f.attributes } as Record<string, unknown>,
      geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    })),
    numberMatched: features.length,
    numberReturned: features.length,
  };
}

// ── GeoServices edit / related / attachment fixtures ─────────

export function geoservicesApplyEditsResponse(): {
  addResults?: Array<{ objectId: number; success: boolean }>;
  updateResults?: Array<{ objectId: number; success: boolean }>;
  deleteResults?: Array<{ objectId: number; success: boolean }>;
} {
  return {
    addResults: [{ objectId: 99, success: true }],
    updateResults: [{ objectId: 1, success: true }],
    deleteResults: [{ objectId: 3, success: true }],
  };
}

export function geoservicesObjectIdsResponse(): { objectIds: number[]; objectIdFieldName: string } {
  return { objectIds: [1, 2, 3], objectIdFieldName: "OBJECTID" };
}

export function geoservicesRelatedRecordsResponse(): {
  relatedRecordGroups: Array<{
    objectId: number;
    relatedRecords: Array<{ attributes: Record<string, unknown>; geometry?: null }>;
  }>;
  fields: Array<{ name: string; type: string }>;
} {
  return {
    relatedRecordGroups: [
      {
        objectId: 1,
        relatedRecords: [
          { attributes: { OBJECTID: 11, NOTE: "permit-A" } },
          { attributes: { OBJECTID: 12, NOTE: "permit-B" } },
        ],
      },
    ],
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "NOTE", type: "esriFieldTypeString" },
    ],
  };
}

export function geoservicesAttachmentInfosResponse(): {
  attachmentInfos: Array<{ id: number; name: string; contentType: string; size: number; parentObjectId: number }>;
} {
  return {
    attachmentInfos: [{ id: 7, parentObjectId: 1, name: "deed.pdf", contentType: "application/pdf", size: 1024 }],
  };
}

export function geoservicesQueryAttachmentsResponse(): {
  attachmentGroups: Array<{
    parentObjectId: number;
    attachmentInfos: Array<{ id: number; name: string; contentType: string; size: number }>;
  }>;
} {
  return {
    attachmentGroups: [
      {
        parentObjectId: 1,
        attachmentInfos: [{ id: 7, name: "deed.pdf", contentType: "application/pdf", size: 1024 }],
      },
    ],
  };
}

export function geoservicesAddAttachmentResponse(): {
  addAttachmentResult: { objectId: number; success: boolean };
} {
  return { addAttachmentResult: { objectId: 7, success: true } };
}

export function geoservicesUpdateAttachmentResponse(): {
  updateAttachmentResult: { objectId: number; success: boolean };
} {
  return { updateAttachmentResult: { objectId: 7, success: true } };
}

export function geoservicesDeleteAttachmentsResponse(): {
  deleteAttachmentResults: Array<{ objectId: number; success: boolean }>;
} {
  return { deleteAttachmentResults: [{ objectId: 7, success: true }] };
}

// ── ImageServer fixtures ─────────────────────────────────────

export function imageServerCatalogResponse(): import("../../src/core/types.js").HonuaQueryResponse {
  return {
    objectIdFieldName: "OBJECTID",
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "Name", type: "esriFieldTypeString" },
    ],
    features: [
      {
        attributes: { OBJECTID: 101, Name: "tile_a" },
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
      },
      {
        attributes: { OBJECTID: 102, Name: "tile_b" },
        geometry: { xmin: -120, ymin: 37, xmax: -117, ymax: 45 },
      },
    ],
    exceededTransferLimit: false,
  };
}

export function imageServerExportResponse(): import("../../src/core/types.js").HonuaExportMapResponse {
  return {
    href: "https://mock/export/abcd.png",
    width: 256,
    height: 256,
    extent: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
    scale: 1,
  };
}

export function imageServerIdentifyResponse(): import("../../src/core/types.js").HonuaIdentifyResponse {
  return {
    results: [
      {
        layerId: 0,
        layerName: "Imagery",
        attributes: { Pixel: "12.4" },
      },
    ],
  };
}

// ── Geometry Service fixtures ────────────────────────────────

export function geometryProjectResponse(): { geometries: Array<Record<string, unknown>> } {
  return {
    geometries: [{ x: 100, y: 200, spatialReference: { wkid: 3857 } }],
  };
}

export function geometryBufferResponse(): { geometries: Array<Record<string, unknown>> } {
  return {
    geometries: [
      {
        rings: [
          [
            [-122, 37],
            [-122, 38],
            [-121, 38],
            [-121, 37],
            [-122, 37],
          ],
        ],
      },
    ],
  };
}

// ── GP Service fixtures ──────────────────────────────────────

export function gpSubmitJobResponse(): { jobId: string; jobStatus: string } {
  return { jobId: "job-001", jobStatus: "esriJobSubmitted" };
}

export function gpJobStatusResponse(): { jobId: string; jobStatus: string } {
  return { jobId: "job-001", jobStatus: "esriJobSucceeded" };
}

// ── WFS 2.0 fixtures ─────────────────────────────────────────

/** Compact `wfs:WFS_Capabilities` document advertising GeoJSON output and one feature type. */
export function wfsCapabilitiesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:parcels="http://parcels.example.test/ns" version="2.0.0">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP><ows:Get/><ows:Post/></ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat">
        <ows:AllowedValues>
          <ows:Value>application/geo+json</ows:Value>
          <ows:Value>application/gml+xml; version=3.2</ows:Value>
        </ows:AllowedValues>
      </ows:Parameter>
    </ows:Operation>
    <ows:Operation name="Transaction">
      <ows:DCP><ows:HTTP><ows:Post/></ows:HTTP></ows:DCP>
    </ows:Operation>
    <ows:Operation name="ListStoredQueries">
      <ows:DCP><ows:HTTP><ows:Get/></ows:HTTP></ows:DCP>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>parcels:lot</wfs:Name>
      <wfs:Title>Parcels</wfs:Title>
      <wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS>
      <wfs:OtherCRS>urn:ogc:def:crs:EPSG::3857</wfs:OtherCRS>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>-123 37</ows:LowerCorner>
        <ows:UpperCorner>-120 45</ows:UpperCorner>
      </ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
  <fes:Filter_Capabilities xmlns:fes="http://www.opengis.net/fes/2.0">
    <fes:Spatial_Capabilities>
      <fes:SpatialOperators>
        <fes:SpatialOperator name="BBOX"/>
        <fes:SpatialOperator name="Intersects"/>
      </fes:SpatialOperators>
    </fes:Spatial_Capabilities>
    <fes:Scalar_Capabilities>
      <fes:ComparisonOperators>
        <fes:ComparisonOperator>PropertyIsEqualTo</fes:ComparisonOperator>
        <fes:ComparisonOperator>PropertyIsLike</fes:ComparisonOperator>
      </fes:ComparisonOperators>
    </fes:Scalar_Capabilities>
  </fes:Filter_Capabilities>
</wfs:WFS_Capabilities>`;
}

/**
 * `DescribeFeatureType` XSD for `parcels:lot`. The adapter reads it to resolve
 * the feature type's geometry property instead of assuming a vendor default.
 */
export function wfsDescribeFeatureTypeXsd(geometryProperty = "the_geom"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:parcels="http://parcels.example.test/ns" elementFormDefault="qualified" targetNamespace="http://parcels.example.test/ns" version="1.0">
  <xsd:import namespace="http://www.opengis.net/gml/3.2" schemaLocation="https://mock.honua.test/schemas/gml/3.2.1/gml.xsd"/>
  <xsd:complexType name="lotType">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType">
        <xsd:sequence>
          <xsd:element maxOccurs="1" minOccurs="0" name="STATE" nillable="true" type="xsd:string"/>
          <xsd:element maxOccurs="1" minOccurs="0" name="ACRES" nillable="true" type="xsd:double"/>
          <xsd:element maxOccurs="1" minOccurs="0" name="${geometryProperty}" nillable="true" type="gml:PointPropertyType"/>
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
  <xsd:element name="lot" substitutionGroup="gml:AbstractFeature" type="parcels:lotType"/>
</xsd:schema>`;
}

/** Same shape as `ogcItemsResponse` but used by the WFS adapter through GeoJSON output. */
export function wfsGeoJsonResponse(features = PARCEL_FEATURES): {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; id: number; properties: Record<string, unknown>; geometry: unknown }>;
  numberMatched: number;
  numberReturned: number;
} {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature" as const,
      id: f.attributes.OBJECTID,
      properties: { ...f.attributes },
      geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    })),
    numberMatched: features.length,
    numberReturned: features.length,
  };
}

/** Successful TransactionResponse acknowledging one insert / one update / one delete. */
export function wfsTransactionResponseXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0">
  <wfs:TransactionSummary>
    <wfs:totalInserted>1</wfs:totalInserted>
    <wfs:totalUpdated>1</wfs:totalUpdated>
    <wfs:totalDeleted>1</wfs:totalDeleted>
  </wfs:TransactionSummary>
  <wfs:InsertResults>
    <wfs:Feature handle="add-1">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.99"/>
    </wfs:Feature>
  </wfs:InsertResults>
</wfs:TransactionResponse>`;
}

export function wfsListStoredQueriesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:ListStoredQueriesResponse xmlns:wfs="http://www.opengis.net/wfs/2.0">
  <wfs:StoredQuery id="urn:ogc:def:query:OGC-WFS::GetFeatureById"/>
  <wfs:StoredQuery id="byKey"/>
</wfs:ListStoredQueriesResponse>`;
}

export function wfsExceptionXml(code = "OperationProcessingFailed", text = "transaction rejected"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
  <ows:Exception exceptionCode="${code}">
    <ows:ExceptionText>${text}</ows:ExceptionText>
  </ows:Exception>
</ows:ExceptionReport>`;
}

export function xmlResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
    ...init,
  });
}
/**
 * Minimal CSDL `$metadata` document covering the surface the OData
 * adapter exercises: an entity set named `Parcels`, a composite
 * `(LayerId, ObjectId)` key, an `Edm.Geography` geometry column, and
 * `Capabilities.*` annotations declaring `Insertable`/`Updatable`/
 * `Deletable`/`BatchSupported` so the adapter's lazy capability
 * negotiation has something to intersect against.
 */
export function odataMetadataDocument(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Parcel">
        <Key>
          <PropertyRef Name="LayerId"/>
          <PropertyRef Name="ObjectId"/>
        </Key>
        <Property Name="LayerId" Type="Edm.Int32" Nullable="false"/>
        <Property Name="ObjectId" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
        <Property Name="ACRES" Type="Edm.Double"/>
        <Property Name="Geometry" Type="Edm.Geography" SRID="4326"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.OData.Parcel">
          <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
            <Record>
              <PropertyValue Property="Insertable" Bool="true"/>
            </Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
            <Record>
              <PropertyValue Property="Updatable" Bool="true"/>
            </Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">
            <Record>
              <PropertyValue Property="Deletable" Bool="true"/>
            </Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.BatchSupported" Bool="true"/>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

/** Single page of an OData entity-set response covering the parcel sample. */
export function odataParcelsResponse(
  features = PARCEL_FEATURES,
  options: { nextLink?: string; count?: number; deltaLink?: string } = {},
): Record<string, unknown> {
  const value = features.map((f, idx) => ({
    LayerId: 1,
    ObjectId: f.attributes.OBJECTID,
    // The cross-protocol conformance test asserts `attributes.OBJECTID`
    // — Honua Server's OData surface emits `ObjectId` per CSDL but
    // duplicating the canonical field keeps the parametric test useful
    // across adapters without a bespoke OData shape.
    OBJECTID: f.attributes.OBJECTID,
    STATE: f.attributes.STATE,
    ACRES: f.attributes.ACRES,
    Geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    "@odata.id": `Parcels(LayerId=1,ObjectId=${f.attributes.OBJECTID})`,
    _seq: idx,
  }));
  const out: Record<string, unknown> = {
    "@odata.context": "https://mock/odata/$metadata#Parcels",
    value,
  };
  if (typeof options.count === "number") out["@odata.count"] = options.count;
  if (options.nextLink) out["@odata.nextLink"] = options.nextLink;
  if (options.deltaLink) out["@odata.deltaLink"] = options.deltaLink;
  return out;
}

/** Aggregated `$apply` response: groupby/STATE → SumAcres. */
export function odataApplyResponse(): Record<string, unknown> {
  return {
    "@odata.context": "https://mock/odata/$metadata#Parcels",
    value: [
      { STATE: "CA", SumAcres: 19.5 },
      { STATE: "OR", SumAcres: 20 },
    ],
  };
}

/** `$batch` JSON response with one PATCH and one DELETE outcome. */
export function odataBatchResponse(): Record<string, unknown> {
  return {
    responses: [
      { id: "1", status: 200, body: { ObjectId: 1, STATE: "CA" } },
      { id: "2", status: 204 },
    ],
  };
}

/** Final `$deltatoken` page emitting `@odata.deltaLink`. */
export function odataDeltaResponse(): Record<string, unknown> {
  return {
    "@odata.context": "https://mock/odata/$metadata#Parcels",
    value: [{ LayerId: 1, ObjectId: 99, STATE: "CA", ACRES: 5 }],
    "@odata.deltaLink": "https://mock/odata/Parcels?$deltatoken=2026-04-23T12%3A00%3A00Z",
  };
}

export function odataMetadataResponse(): Response {
  return new Response(odataMetadataDocument(), {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

/**
 * `$metadata` document shaped the way `honua-server`'s
 * `ODataMetadataService` emits it: capability annotations live in
 * **sibling** `<Annotations Target="<Schema>.<Container>/<EntitySet>">`
 * blocks (next to `<EntityContainer>`), not nested inside `<EntitySet>`.
 * `<EntitySet>` carries only `<NavigationPropertyBinding>` children. The
 * SDK's metadata parser must merge the sibling annotations with any
 * inline ones to honor capability advertisements correctly.
 */
export function odataMetadataDocumentServerShape(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Feature">
        <Key>
          <PropertyRef Name="LayerId"/>
          <PropertyRef Name="ObjectId"/>
        </Key>
        <Property Name="LayerId" Type="Edm.Int32" Nullable="false"/>
        <Property Name="ObjectId" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
        <Property Name="ACRES" Type="Edm.Double"/>
        <Property Name="Geometry" Type="Edm.Geography" SRID="4326"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Features" EntityType="Honua.Feature">
          <NavigationPropertyBinding Path="Layer" Target="Layers"/>
        </EntitySet>
      </EntityContainer>
      <Annotations Target="Honua.Container/Features">
        <Annotation Term="Capabilities.FilterRestrictions">
          <Record>
            <PropertyValue Property="Filterable" Bool="true"/>
            <PropertyValue Property="RequiresFilter" Bool="true"/>
            <PropertyValue Property="RequiredProperties">
              <Collection>
                <PropertyPath>LayerId</PropertyPath>
              </Collection>
            </PropertyValue>
          </Record>
        </Annotation>
        <Annotation Term="Capabilities.SearchRestrictions">
          <Record><PropertyValue Property="Searchable" Bool="true"/></Record>
        </Annotation>
        <Annotation Term="Capabilities.ExpandRestrictions">
          <Record><PropertyValue Property="Expandable" Bool="true"/></Record>
        </Annotation>
        <Annotation Term="Capabilities.ChangeTracking">
          <Record><PropertyValue Property="Supported" Bool="true"/></Record>
        </Annotation>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
}

export function odataMetadataResponseServerShape(): Response {
  return new Response(odataMetadataDocumentServerShape(), {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}

/** Single page response shaped like honua-server's `/odata/Layers(<id>)/Features`. */
export function odataServerFeaturesResponse(features = PARCEL_FEATURES): Record<string, unknown> {
  return {
    "@odata.context": "https://mock/odata/$metadata#Features",
    value: features.map((f) => ({
      LayerId: 1,
      ObjectId: f.attributes.OBJECTID,
      OBJECTID: f.attributes.OBJECTID,
      STATE: f.attributes.STATE,
      ACRES: f.attributes.ACRES,
      Geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    })),
  };
}
