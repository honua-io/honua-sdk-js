// AUTO-RECORDED FIXTURE DATA — do not hand-edit.
//
// Recorded from the public Esri Living Atlas FeatureServer (services.arcgis.com):
//   https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0
// US Census 2020 apportionment (public-domain data), publicly shared by Esri —
// anonymous, read-only. Re-record with mcp/scripts/record-census-fixtures.mjs.
//
// This is the platform-free proof corpus: 52 rows (50 states + DC + Puerto Rico),
// used to certify and eval @honua/mcp-server against a plain public FeatureServer
// with ZERO Honua-server surfaces. Known aggregate anchors (verified live):
//   rows=52  sum(pop)=335085841  sum(seats)=435  max(pop)=California(39576757)
//   min(pop)=Wyoming(577719)  seats>=20 => 4 states (CA,TX,FL,NY).

export interface CensusRow {
  OBJECTID: number;
  NAME: string;
  STUSPS: string;
  Total_Pop_2020: number | null;
  // District of Columbia and Puerto Rico carry no apportioned seats (null),
  // exactly as the upstream layer records them.
  Seats_2020: number | null;
}

/** The public FeatureServer this fixture was recorded from. */
export const CENSUS_ENDPOINT =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";

/** Service id (as it appears under /rest/services) for the recorded service. */
export const CENSUS_SERVICE_ID = "2020_Census_State_Apportionment";

/** Human layer name as advertised by the live layer metadata. */
export const CENSUS_LAYER_NAME = "States 2020 Apportionment - U.S. House of Representatives Seats";

/** Recorded layer extent (Web Mercator, wkid 102100). */
export const CENSUS_EXTENT = {
  xmin: -19942592.3656,
  ymin: 2024070.8216000013,
  xmax: 20012846.037699997,
  ymax: 11523911.845299996,
  spatialReference: { wkid: 102100, latestWkid: 3857 },
} as const;

/** Recorded field list for layer 0 (all 22 fields, verbatim). */
export const CENSUS_FIELDS: ReadonlyArray<{ name: string; type: string; alias: string }> = [
  {
    name: "OBJECTID",
    type: "esriFieldTypeOID",
    alias: "OBJECTID",
  },
  {
    name: "NAME",
    type: "esriFieldTypeString",
    alias: "State Name",
  },
  {
    name: "STUSPS",
    type: "esriFieldTypeString",
    alias: "State Abbreviation",
  },
  {
    name: "GEO_ID",
    type: "esriFieldTypeString",
    alias: "GEOID FIPS Code",
  },
  {
    name: "STATENS",
    type: "esriFieldTypeString",
    alias: "STATENS",
  },
  {
    name: "GEOID",
    type: "esriFieldTypeString",
    alias: "GEOID FIPS Code",
  },
  {
    name: "Total_Pop_2020",
    type: "esriFieldTypeInteger",
    alias: "Total Population, 2020",
  },
  {
    name: "Seats_2020",
    type: "esriFieldTypeInteger",
    alias: "Seats in the U.S. House of Representatives, 2020",
  },
  {
    name: "Resident_Pop_2020",
    type: "esriFieldTypeInteger",
    alias: "Resident Population, 2020",
  },
  {
    name: "Overseas_Pop_2020",
    type: "esriFieldTypeInteger",
    alias: "Overseas Population, 2020",
  },
  {
    name: "Total_Pop_2010",
    type: "esriFieldTypeInteger",
    alias: "Total Population, 2010",
  },
  {
    name: "Seats_2010",
    type: "esriFieldTypeInteger",
    alias: "Seats in the U.S. House of Representatives, 2010",
  },
  {
    name: "Resident_Pop_2010",
    type: "esriFieldTypeInteger",
    alias: "Resident Population, 2010",
  },
  {
    name: "Overseas_Pop_2010",
    type: "esriFieldTypeInteger",
    alias: "Overseas Population, 2010",
  },
  {
    name: "TotalPopChange_2010to2020",
    type: "esriFieldTypeInteger",
    alias: "Change in Total Population, 2010 to 2020",
  },
  {
    name: "Total_Pct_Change_2010to2020",
    type: "esriFieldTypeDouble",
    alias: "Percent Change in Total Population, 2010 to 2020",
  },
  {
    name: "Seats_Change_2010to2020",
    type: "esriFieldTypeSmallInteger",
    alias: "Change in Seats in the U.S. House of Representatives, 2010 to 2020",
  },
  {
    name: "Seats_Change_2000to2010",
    type: "esriFieldTypeSmallInteger",
    alias: "Change in Seats in the U.S. House of Representatives, 2000 to 2010",
  },
  {
    name: "Resident_Change_2010to2020",
    type: "esriFieldTypeInteger",
    alias: "Change in Resident Population, 2010 to 2020",
  },
  {
    name: "Resident_Pct_Change_2010to2020",
    type: "esriFieldTypeDouble",
    alias: "Percent Change in Resident Population, 2010 to 2020",
  },
  {
    name: "Shape__Area",
    type: "esriFieldTypeDouble",
    alias: "Shape__Area",
  },
  {
    name: "Shape__Length",
    type: "esriFieldTypeDouble",
    alias: "Shape__Length",
  },
];

/** All 52 recorded rows (attribute-only; geometry omitted to keep the fixture small). */
export const CENSUS_ROWS: ReadonlyArray<CensusRow> = [
  {
    OBJECTID: 1,
    NAME: "Alabama",
    STUSPS: "AL",
    Total_Pop_2020: 5030053,
    Seats_2020: 7,
  },
  {
    OBJECTID: 2,
    NAME: "Alaska",
    STUSPS: "AK",
    Total_Pop_2020: 736081,
    Seats_2020: 1,
  },
  {
    OBJECTID: 3,
    NAME: "Arizona",
    STUSPS: "AZ",
    Total_Pop_2020: 7158923,
    Seats_2020: 9,
  },
  {
    OBJECTID: 4,
    NAME: "Arkansas",
    STUSPS: "AR",
    Total_Pop_2020: 3013756,
    Seats_2020: 4,
  },
  {
    OBJECTID: 5,
    NAME: "California",
    STUSPS: "CA",
    Total_Pop_2020: 39576757,
    Seats_2020: 52,
  },
  {
    OBJECTID: 6,
    NAME: "Colorado",
    STUSPS: "CO",
    Total_Pop_2020: 5782171,
    Seats_2020: 8,
  },
  {
    OBJECTID: 7,
    NAME: "Connecticut",
    STUSPS: "CT",
    Total_Pop_2020: 3608298,
    Seats_2020: 5,
  },
  {
    OBJECTID: 8,
    NAME: "Delaware",
    STUSPS: "DE",
    Total_Pop_2020: 990837,
    Seats_2020: 1,
  },
  {
    OBJECTID: 9,
    NAME: "District of Columbia",
    STUSPS: "DC",
    Total_Pop_2020: 691533,
    Seats_2020: null,
  },
  {
    OBJECTID: 10,
    NAME: "Florida",
    STUSPS: "FL",
    Total_Pop_2020: 21570527,
    Seats_2020: 28,
  },
  {
    OBJECTID: 11,
    NAME: "Georgia",
    STUSPS: "GA",
    Total_Pop_2020: 10725274,
    Seats_2020: 14,
  },
  {
    OBJECTID: 12,
    NAME: "Hawaii",
    STUSPS: "HI",
    Total_Pop_2020: 1460137,
    Seats_2020: 2,
  },
  {
    OBJECTID: 13,
    NAME: "Idaho",
    STUSPS: "ID",
    Total_Pop_2020: 1841377,
    Seats_2020: 2,
  },
  {
    OBJECTID: 14,
    NAME: "Illinois",
    STUSPS: "IL",
    Total_Pop_2020: 12822739,
    Seats_2020: 17,
  },
  {
    OBJECTID: 15,
    NAME: "Indiana",
    STUSPS: "IN",
    Total_Pop_2020: 6790280,
    Seats_2020: 9,
  },
  {
    OBJECTID: 16,
    NAME: "Iowa",
    STUSPS: "IA",
    Total_Pop_2020: 3192406,
    Seats_2020: 4,
  },
  {
    OBJECTID: 17,
    NAME: "Kansas",
    STUSPS: "KS",
    Total_Pop_2020: 2940865,
    Seats_2020: 4,
  },
  {
    OBJECTID: 18,
    NAME: "Kentucky",
    STUSPS: "KY",
    Total_Pop_2020: 4509342,
    Seats_2020: 6,
  },
  {
    OBJECTID: 19,
    NAME: "Louisiana",
    STUSPS: "LA",
    Total_Pop_2020: 4661468,
    Seats_2020: 6,
  },
  {
    OBJECTID: 20,
    NAME: "Maine",
    STUSPS: "ME",
    Total_Pop_2020: 1363582,
    Seats_2020: 2,
  },
  {
    OBJECTID: 21,
    NAME: "Maryland",
    STUSPS: "MD",
    Total_Pop_2020: 6185278,
    Seats_2020: 8,
  },
  {
    OBJECTID: 22,
    NAME: "Massachusetts",
    STUSPS: "MA",
    Total_Pop_2020: 7033469,
    Seats_2020: 9,
  },
  {
    OBJECTID: 23,
    NAME: "Michigan",
    STUSPS: "MI",
    Total_Pop_2020: 10084442,
    Seats_2020: 13,
  },
  {
    OBJECTID: 24,
    NAME: "Minnesota",
    STUSPS: "MN",
    Total_Pop_2020: 5709752,
    Seats_2020: 8,
  },
  {
    OBJECTID: 25,
    NAME: "Mississippi",
    STUSPS: "MS",
    Total_Pop_2020: 2963914,
    Seats_2020: 4,
  },
  {
    OBJECTID: 26,
    NAME: "Missouri",
    STUSPS: "MO",
    Total_Pop_2020: 6160281,
    Seats_2020: 8,
  },
  {
    OBJECTID: 27,
    NAME: "Montana",
    STUSPS: "MT",
    Total_Pop_2020: 1085407,
    Seats_2020: 2,
  },
  {
    OBJECTID: 28,
    NAME: "Nebraska",
    STUSPS: "NE",
    Total_Pop_2020: 1963333,
    Seats_2020: 3,
  },
  {
    OBJECTID: 29,
    NAME: "Nevada",
    STUSPS: "NV",
    Total_Pop_2020: 3108462,
    Seats_2020: 4,
  },
  {
    OBJECTID: 30,
    NAME: "New Hampshire",
    STUSPS: "NH",
    Total_Pop_2020: 1379089,
    Seats_2020: 2,
  },
  {
    OBJECTID: 31,
    NAME: "New Jersey",
    STUSPS: "NJ",
    Total_Pop_2020: 9294493,
    Seats_2020: 12,
  },
  {
    OBJECTID: 32,
    NAME: "New Mexico",
    STUSPS: "NM",
    Total_Pop_2020: 2120220,
    Seats_2020: 3,
  },
  {
    OBJECTID: 33,
    NAME: "New York",
    STUSPS: "NY",
    Total_Pop_2020: 20215751,
    Seats_2020: 26,
  },
  {
    OBJECTID: 34,
    NAME: "North Carolina",
    STUSPS: "NC",
    Total_Pop_2020: 10453948,
    Seats_2020: 14,
  },
  {
    OBJECTID: 35,
    NAME: "North Dakota",
    STUSPS: "ND",
    Total_Pop_2020: 779702,
    Seats_2020: 1,
  },
  {
    OBJECTID: 36,
    NAME: "Ohio",
    STUSPS: "OH",
    Total_Pop_2020: 11808848,
    Seats_2020: 15,
  },
  {
    OBJECTID: 37,
    NAME: "Oklahoma",
    STUSPS: "OK",
    Total_Pop_2020: 3963516,
    Seats_2020: 5,
  },
  {
    OBJECTID: 38,
    NAME: "Oregon",
    STUSPS: "OR",
    Total_Pop_2020: 4241500,
    Seats_2020: 6,
  },
  {
    OBJECTID: 39,
    NAME: "Pennsylvania",
    STUSPS: "PA",
    Total_Pop_2020: 13011844,
    Seats_2020: 17,
  },
  {
    OBJECTID: 52,
    NAME: "Puerto Rico",
    STUSPS: "PR",
    Total_Pop_2020: 3285874,
    Seats_2020: null,
  },
  {
    OBJECTID: 40,
    NAME: "Rhode Island",
    STUSPS: "RI",
    Total_Pop_2020: 1098163,
    Seats_2020: 2,
  },
  {
    OBJECTID: 41,
    NAME: "South Carolina",
    STUSPS: "SC",
    Total_Pop_2020: 5124712,
    Seats_2020: 7,
  },
  {
    OBJECTID: 42,
    NAME: "South Dakota",
    STUSPS: "SD",
    Total_Pop_2020: 887770,
    Seats_2020: 1,
  },
  {
    OBJECTID: 43,
    NAME: "Tennessee",
    STUSPS: "TN",
    Total_Pop_2020: 6916897,
    Seats_2020: 9,
  },
  {
    OBJECTID: 44,
    NAME: "Texas",
    STUSPS: "TX",
    Total_Pop_2020: 29183290,
    Seats_2020: 38,
  },
  {
    OBJECTID: 45,
    NAME: "Utah",
    STUSPS: "UT",
    Total_Pop_2020: 3275252,
    Seats_2020: 4,
  },
  {
    OBJECTID: 46,
    NAME: "Vermont",
    STUSPS: "VT",
    Total_Pop_2020: 643503,
    Seats_2020: 1,
  },
  {
    OBJECTID: 47,
    NAME: "Virginia",
    STUSPS: "VA",
    Total_Pop_2020: 8654542,
    Seats_2020: 11,
  },
  {
    OBJECTID: 48,
    NAME: "Washington",
    STUSPS: "WA",
    Total_Pop_2020: 7715946,
    Seats_2020: 10,
  },
  {
    OBJECTID: 49,
    NAME: "West Virginia",
    STUSPS: "WV",
    Total_Pop_2020: 1795045,
    Seats_2020: 2,
  },
  {
    OBJECTID: 50,
    NAME: "Wisconsin",
    STUSPS: "WI",
    Total_Pop_2020: 5897473,
    Seats_2020: 8,
  },
  {
    OBJECTID: 51,
    NAME: "Wyoming",
    STUSPS: "WY",
    Total_Pop_2020: 577719,
    Seats_2020: 1,
  },
];
