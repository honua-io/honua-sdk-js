import { canonicalJson } from "./determinism.mjs";

export const FIXTURE_LICENSE_REGISTRY_VERSION = "honua.fixture-license-registry/v1";

const RECORDS = {
  "Apache-2.0": {
    registryVersion: FIXTURE_LICENSE_REGISTRY_VERSION,
    expression: "Apache-2.0",
    termsUrl: "https://www.apache.org/licenses/LICENSE-2.0.txt",
    termsSha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    citation: "Copyright Honua contributors; synthetic demonstration data.",
    attributionRequired: true,
    redistributionAllowed: true,
    shareAlikeRequired: false,
    disclaimer:
      "Licensed under the Apache License, Version 2.0; distributed on an AS IS basis, without warranties or conditions.",
  },
  "LicenseRef-US-Government-Work": {
    registryVersion: FIXTURE_LICENSE_REGISTRY_VERSION,
    expression: "LicenseRef-US-Government-Work",
    termsUrl: "https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2025/TGRSHP2025_TechDoc_Ch1.pdf",
    termsSha256: "ce40bee768cdb00f9dadc154ca0b1dc6ca91180c1b9362e5d2b70cbea2d75003",
    citation: "Source: U.S. Census Bureau, 2025 TIGER/Line Shapefiles.",
    attributionRequired: false,
    redistributionAllowed: true,
    shareAlikeRequired: false,
    disclaimer:
      "Statistical boundaries are not legal land descriptions, do not determine jurisdiction or ownership, and are provided without warranty.",
  },
};

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FIXTURE_LICENSE_RECORDS = deepFreeze(structuredClone(RECORDS));

export function fixtureLicenseRecord(expression) {
  const record = FIXTURE_LICENSE_RECORDS[expression];
  if (!record) throw new Error(`Fixture license expression is not registered: ${String(expression)}`);
  return structuredClone(record);
}

export function assertRegisteredFixtureLicense(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Fixture license must be an exact registered record.");
  }
  if (
    record.expression === "NOASSERTION" ||
    (String(record.expression).startsWith("LicenseRef-") && record.expression !== "LicenseRef-US-Government-Work")
  ) {
    throw new Error("Fixture license expression is not registered.");
  }
  const expected = FIXTURE_LICENSE_RECORDS[record.expression];
  if (!expected || canonicalJson(record) !== canonicalJson(expected)) {
    throw new Error("Fixture license must exactly match the closed fixture license registry.");
  }
  return record;
}
