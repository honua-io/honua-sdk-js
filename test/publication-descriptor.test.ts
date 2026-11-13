import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  HonuaPublicationError,
  publicationDescriptorIssues,
  validatePublicationDescriptor,
} from "../src/publication/index.js";

const repoFile = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const readJson = (relative: string) => JSON.parse(readFileSync(repoFile(relative), "utf8"));
const vendor = readJson("config/publication-descriptor.v1.vendor.json") as {
  readonly repository: string;
  readonly commit: string;
  readonly files: Readonly<Record<string, { readonly source: string; readonly sha256: string }>>;
};
const examplesDirectory = "test/fixtures/publication/descriptor-v1";
const expectedFailures = readJson(`${examplesDirectory}/invalid/expected.json`) as Record<string, string>;

const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const schemaValidator = ajv.compile(readJson("config/publication-descriptor.v1.schema.json"));

describe("vendored publication descriptor v1", () => {
  it("matches the pinned server copy byte for byte", () => {
    expect(vendor.repository).toBe("honua-io/honua-server");
    expect(vendor.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const [file, pin] of Object.entries(vendor.files)) {
      const digest = createHash("sha256")
        .update(readFileSync(repoFile(file)))
        .digest("hex");
      expect(digest, `${file} drifted from ${pin.source} at ${vendor.commit}`).toBe(pin.sha256);
    }
  });

  it("pins the schema and every example the server checks in", () => {
    const invalid = readdirSync(repoFile(`${examplesDirectory}/invalid`)).map(
      (name) => `${examplesDirectory}/invalid/${name}`,
    );
    expect(Object.keys(vendor.files).sort()).toEqual(
      [
        "config/publication-descriptor.v1.schema.json",
        `${examplesDirectory}/maui-county-parcels.json`,
        ...invalid,
      ].sort(),
    );
  });
});

describe("validatePublicationDescriptor", () => {
  it("accepts the server's Maui County example and the committed fixture", () => {
    for (const file of [
      `${examplesDirectory}/maui-county-parcels.json`,
      "test/fixtures/publication/maui-parcels/descriptor.json",
    ]) {
      const document = readJson(file);
      expect(schemaValidator(document), JSON.stringify(schemaValidator.errors)).toBe(true);
      expect(publicationDescriptorIssues(document)).toEqual([]);
      expect(validatePublicationDescriptor(document).publicationId).toMatch(/^maui-county-parcels/);
    }
  });

  it.each(Object.entries(expectedFailures))("rejects %s for %s, as the server does", (file, expected) => {
    const document = readJson(`${examplesDirectory}/invalid/${file}`);
    const issues = publicationDescriptorIssues(document);
    if (expected === "schema") {
      expect(schemaValidator(document)).toBe(false);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => issue.rule === "schema")).toBe(true);
    } else {
      expect(schemaValidator(document), JSON.stringify(schemaValidator.errors)).toBe(true);
      expect([...new Set(issues.map((issue) => issue.rule))]).toEqual([expected]);
    }
    expect(() => validatePublicationDescriptor(document)).toThrow(HonuaPublicationError);
  });

  it("agrees with the reference validator on single-field mutations of the example", () => {
    const base = readJson(`${examplesDirectory}/maui-county-parcels.json`);
    const mutations: ReadonlyArray<(document: Record<string, any>) => void> = [
      (document) => {
        document.extra = true;
      },
      (document) => {
        document.publishedAt = "13 November 2026";
      },
      (document) => {
        document.publicationId = "Maui Parcels";
      },
      (document) => {
        document.artifacts.pmtiles.sha256 = "ABC";
      },
      (document) => {
        document.artifacts.geoparquet.mediaType = "application/octet-stream";
      },
      (document) => {
        document.artifacts.pmtiles.vectorLayer = undefined;
      },
      (document) => {
        document.artifacts.catalog = { ...document.artifacts.geoparquet, mediaType: "application/json", extra: 1 };
      },
      (document) => {
        document.artifacts.catalog = {
          ...document.artifacts.geoparquet,
          mediaType: "application/json",
          rowGroups: undefined,
        };
      },
      (document) => {
        document.capture.filter = {};
      },
      (document) => {
        document.crs.source = "WGS84";
      },
      (document) => {
        document.validation.checks[0].status = "skipped";
      },
      (document) => {
        document.links.source = "not a uri";
      },
      (document) => {
        document.bounds = [-156.5, 20.8, -156.4];
      },
      (document) => {
        document.fields[0].type = "text";
      },
      (document) => {
        document["constructor"] = 42;
      },
      (document) => {
        document.artifacts.constructor = 42;
      },
      (document) => {
        document.version = "\u{1F30A}".repeat(40);
      },
    ];
    for (const mutate of mutations) {
      const document = structuredClone(base);
      mutate(document);
      const serialized = JSON.parse(JSON.stringify(document));
      const schemaValid = schemaValidator(serialized);
      const sdkSchemaIssues = publicationDescriptorIssues(serialized).filter((issue) => issue.rule === "schema");
      expect(sdkSchemaIssues.length === 0, `${mutate.toString()}: ${JSON.stringify(sdkSchemaIssues)}`).toBe(
        schemaValid,
      );
    }
  });

  it("refuses to open a publication that did not pass validation", () => {
    const document = readJson(`${examplesDirectory}/maui-county-parcels.json`);
    document.validation.status = "failed";
    expect(publicationDescriptorIssues(document)).toEqual([]);
    expect(() => validatePublicationDescriptor(document)).toThrow(/did not pass validation/);
  });
});
