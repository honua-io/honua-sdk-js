// AUTO-RECORDED FIXTURE DATA — do not hand-edit.
//
// Recorded from the public pygeoapi demo (an OGC API Features implementation with
// no Esri/GeoServices surface at all):
//   https://demo.pygeoapi.io/master
// This is the pinned `ogc-features` conformance target in
// config/live-conformance-endpoints.v1.json — anonymous, read-only, open sample
// data. Re-record with mcp/scripts/record-ogc-fixtures.mjs.
//
// It is the NON-GeoServices proof corpus for the protocol-neutral tool contract
// (issue #1005): the same MCP tools that certify against a plain Esri
// FeatureServer must certify against this endpoint too, addressing sources as
// `ogc-features:<collectionId>` and degrading honestly where OGC API Features
// has no server-side equivalent (aggregation, extent-of-a-filtered-set).

/** A recorded OGC API Features collection: metadata, queryables, and every item. */
export interface OgcFixtureCollection {
  readonly collection: {
    readonly id: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly extent: unknown;
    readonly crs: readonly string[] | null;
    readonly itemType: string;
  };
  readonly queryables: Record<string, { type?: string; title?: string; [key: string]: unknown }> | null;
  readonly features: ReadonlyArray<{
    readonly type: "Feature";
    readonly id?: string | number;
    readonly geometry: Record<string, unknown> | null;
    readonly properties: Record<string, unknown> | null;
  }>;
  readonly numberMatched: number;
}

/** The public OGC API Features endpoint these fixtures were recorded from. */
export const OGC_ENDPOINT = "https://demo.pygeoapi.io/master";

/** Recorded collections, keyed by collection id. */
export const OGC_COLLECTIONS: Readonly<Record<string, OgcFixtureCollection>> = {
  obs: {
    collection: {
      id: "obs",
      title: "Observations",
      description: "Observations",
      extent: {
        spatial: {
          bbox: [[-180, -90, 180, 90]],
          crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        },
        temporal: {
          interval: [["2000-10-30T18:24:39+00:00", "2007-10-30T08:57:29+00:00"]],
        },
      },
      crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
      itemType: "feature",
    },
    queryables: {
      geometry: {
        format: "geometry-any",
        "x-ogc-role": "primary-geometry",
      },
      id: {
        title: "id",
        type: "string",
        "x-ogc-role": "id",
      },
      stn_id: {
        title: "stn_id",
        type: "integer",
      },
      datetime: {
        title: "datetime",
        type: "string",
      },
      value: {
        title: "value",
        type: "number",
      },
    },
    features: [
      {
        type: "Feature",
        id: "371",
        geometry: {
          type: "Point",
          coordinates: [-75, 45],
        },
        properties: {
          id: 371,
          stn_id: 35,
          datetime: "2001-10-30T14:24:55Z",
          value: 89.9,
        },
      },
      {
        type: "Feature",
        id: "377",
        geometry: {
          type: "Point",
          coordinates: [-75, 45],
        },
        properties: {
          id: 377,
          stn_id: 35,
          datetime: "2002-10-30T18:31:38Z",
          value: 93.9,
        },
      },
      {
        type: "Feature",
        id: "238",
        geometry: {
          type: "Point",
          coordinates: [-79, 43],
        },
        properties: {
          id: 238,
          stn_id: 2147,
          datetime: "2007-10-30T08:57:29Z",
          value: 103.5,
        },
      },
      {
        type: "Feature",
        id: "297",
        geometry: {
          type: "Point",
          coordinates: [-79, 43],
        },
        properties: {
          id: 297,
          stn_id: 2147,
          datetime: "2003-10-30T07:37:29Z",
          value: 93.5,
        },
      },
      {
        type: "Feature",
        id: "964",
        geometry: {
          type: "Point",
          coordinates: [-122, 49],
        },
        properties: {
          id: 964,
          stn_id: 604,
          datetime: "2000-10-30T18:24:39Z",
          value: 99.9,
        },
      },
    ],
    numberMatched: 5,
  },
  utah_city_locations: {
    collection: {
      id: "utah_city_locations",
      title: "Cities in Utah via OGR WFS",
      description:
        "Data from the state of Utah. Standard demo dataset from the deegree WFS server that is used as backend WFS.",
      extent: {
        spatial: {
          bbox: [[-112.108489, 39.854053, -111.028628, 40.460098]],
          crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        },
        temporal: {
          interval: [[null, null]],
        },
      },
      crs: [
        "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
        "http://www.opengis.net/def/crs/EPSG/0/4326",
        "http://www.opengis.net/def/crs/EPSG/0/26912",
      ],
      itemType: "feature",
    },
    queryables: {
      geometry: {
        format: "geometry-any",
        "x-ogc-role": "primary-geometry",
      },
      gml_id: {
        title: "gml_id",
        type: "string",
      },
      NAME: {
        title: "NAME",
        type: "string",
        "x-ogc-role": "id",
      },
      CO_SEAT: {
        title: "CO_SEAT",
        type: "string",
      },
      POP_1999: {
        title: "POP_1999",
        type: "number",
      },
      POP_SYM_99: {
        title: "POP_SYM_99",
        type: "number",
      },
      POP_2000: {
        title: "POP_2000",
        type: "number",
      },
      POP_SYM_00: {
        title: "POP_SYM_00",
        type: "number",
      },
      STATE: {
        title: "STATE",
        type: "string",
      },
    },
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.74817810768609, 40.402923255649355],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_0",
          CO_SEAT: "no",
          POP_1999: 2486,
          POP_SYM_99: 11,
          POP_2000: 3094,
          POP_SYM_00: 13,
          STATE: "Utah",
        },
        id: "Cedar Hills",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-112.10642143704527, 40.32859823115939],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_1",
          CO_SEAT: "no",
          POP_1999: 254,
          POP_SYM_99: 11,
          POP_2000: 341,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Cedar Fort",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-112.09120295344516, 40.261872974521346],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_2",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Fairfield",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.70279082657271, 40.02031031420355],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_3",
          CO_SEAT: "no",
          POP_1999: 1721,
          POP_SYM_99: 11,
          POP_2000: 1838,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Elk Ridge",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.67170979865375, 40.01324186213496],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_4",
          CO_SEAT: "no",
          POP_1999: 1307,
          POP_SYM_99: 11,
          POP_2000: 941,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Woodland Hills",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.75203641744108, 40.00269815544565],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_5",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Spring Lake",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.89952776000335, 39.95433758204423],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_6",
          CO_SEAT: "no",
          POP_1999: 533,
          POP_SYM_99: 11,
          POP_2000: 874,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Goshen",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.95624062686363, 39.95352144639919],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_7",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Elberta",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.19527332389515, 39.93488426228323],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_8",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Tucker",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.5438310883729, 39.9250445708663],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_9",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Birdseye",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.0286281490483, 39.859253355036785],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_10",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Colton",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.73348373951536, 40.273639653771234],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_11",
          CO_SEAT: "no",
          POP_1999: 146,
          POP_SYM_99: 11,
          POP_2000: 150,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Vineyard",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.5014858713705, 39.98379021825235],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_12",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Thistle",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.7734883904782, 39.974442271658695],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_13",
          CO_SEAT: "no",
          POP_1999: 2700,
          POP_SYM_99: 13,
          POP_2000: 4834,
          POP_SYM_00: 13,
          STATE: "Utah",
        },
        id: "Santaquin",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.58873594660037, 40.08310610041509],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_14",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Moark Jct.",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.70130336258471, 40.31376088289488],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_15",
          CO_SEAT: "no",
          POP_1999: 78937,
          POP_SYM_99: 441,
          POP_2000: 84324,
          POP_SYM_00: 441,
          STATE: "Utah",
        },
        id: "Orem",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.65798532043658, 40.23758070094292],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_16",
          CO_SEAT: "yes",
          POP_1999: 110419,
          POP_SYM_99: 442,
          POP_2000: 105166,
          POP_SYM_00: 442,
          STATE: "Utah",
        },
        id: "PROVO",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.85435868468649, 40.388556775283504],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_17",
          CO_SEAT: "no",
          POP_1999: 15297,
          POP_SYM_99: 15,
          POP_2000: 19028,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Lehi",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.73873181605252, 40.365627839302014],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_18",
          CO_SEAT: "no",
          POP_1999: 20491,
          POP_SYM_99: 15,
          POP_2000: 23468,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Pleasant Grove",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.61281669592616, 40.16185958849041],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_19",
          CO_SEAT: "no",
          POP_1999: 15944,
          POP_SYM_99: 15,
          POP_2000: 20424,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Springville",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.65036678892355, 40.11644965817001],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_20",
          CO_SEAT: "no",
          POP_1999: 15555,
          POP_SYM_99: 15,
          POP_2000: 20246,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Spanish Fork",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.73391237191078, 40.04455779497455],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_21",
          CO_SEAT: "no",
          POP_1999: 10951,
          POP_SYM_99: 15,
          POP_2000: 12716,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Payson",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.79044778265178, 40.42315104482651],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_22",
          CO_SEAT: "no",
          POP_1999: 6315,
          POP_SYM_99: 15,
          POP_2000: 8172,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Highland",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.71967409007256, 40.343504455061094],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_23",
          CO_SEAT: "no",
          POP_1999: 6380,
          POP_SYM_99: 15,
          POP_2000: 8363,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Lindon",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.5796750551626, 40.1307898275457],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_24",
          CO_SEAT: "no",
          POP_1999: 4804,
          POP_SYM_99: 13,
          POP_2000: 5809,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Mapleton",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.67183507997295, 40.056709946862874],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_25",
          CO_SEAT: "no",
          POP_1999: 3275,
          POP_SYM_99: 13,
          POP_2000: 4372,
          POP_SYM_00: 13,
          STATE: "Utah",
        },
        id: "Salem",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.84393834673808, 39.99788938878432],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_26",
          CO_SEAT: "no",
          POP_1999: 868,
          POP_SYM_99: 11,
          POP_2000: 965,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Genola",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-112.06133350316209, 39.95467459986656],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_27",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Dividend",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.90465660608737, 40.33883883118198],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_28",
          CO_SEAT: "no",
          POP_1999: 0,
          POP_SYM_99: 11,
          POP_2000: 0,
          POP_SYM_00: 11,
          STATE: "Utah",
        },
        id: "Saratoga Springs",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.77773152916332, 40.45748493335309],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_29",
          CO_SEAT: "no",
          POP_1999: 5418,
          POP_SYM_99: 15,
          POP_2000: 7146,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "Alpine",
      },
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-111.79611593500199, 40.37987779198327],
        },
        properties: {
          gml_id: "SGID93_LOCATION_UDOTMAP_CITYLOCATIONS_30",
          CO_SEAT: "no",
          POP_1999: 19215,
          POP_SYM_99: 15,
          POP_2000: 21941,
          POP_SYM_00: 15,
          STATE: "Utah",
        },
        id: "American Fork",
      },
    ],
    numberMatched: 31,
  },
} as const;

/** Collection ids in advertised order. */
export const OGC_COLLECTION_IDS: readonly string[] = ["obs", "utah_city_locations"];
