/**
 * Drift gate between `schemas/honua-map-package.v1.json` and the TypeScript
 * declaration of the same artifact in `src/runtime/map-package.ts`.
 *
 * This suite is the reason the schema is worth having. A JSON Schema that sits
 * beside a TypeScript type and is never mechanically compared to it is strictly
 * worse than no schema at all: it reads as a contract, it is cited as a
 * contract, and it silently stops describing the thing the code actually
 * produces the first time somebody adds a field in one place. So the test does
 * not check a hand-written list of expectations — it *parses* the TypeScript
 * with the compiler API and requires the two descriptions to agree on:
 *
 *   - which interfaces exist at all (a new type with no `$def` fails; a `$def`
 *     with no type fails);
 *   - the exact property-name set of every one of them;
 *   - which properties are optional (TS `?` ⟺ absent from schema `required`);
 *   - the members of every string-literal union that the schema also
 *     enumerates, including the nested ones on widgets, dependencies, and
 *     label placement;
 *   - the canonical `format` const.
 *
 * The one deliberate exemption is `mapSpec`: it is a MapLibre style document,
 * validated by `@maplibre/maplibre-gl-style-spec` rather than restated here,
 * and the exemption is asserted explicitly below so it cannot silently grow.
 */

import fs from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  HONUA_MAP_PACKAGE_SCHEMA_ID,
  HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS,
  HONUA_MAP_PACKAGE_SCHEMA_STATUSES,
} from "../../src/runtime/generated/map-package-schema-meta.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "../../src/runtime/index.js";

const SCHEMA_URL = new URL("../../schemas/honua-map-package.v1.json", import.meta.url);
const TYPES_URL = new URL("../../src/runtime/map-package.ts", import.meta.url);
const VALIDATOR_URL = new URL("../../src/runtime/generated/map-package-schema-validator.ts", import.meta.url);

const schema = JSON.parse(fs.readFileSync(SCHEMA_URL, "utf8"));
const typesSource = fs.readFileSync(TYPES_URL, "utf8");

/**
 * Interface → schema location. The root package maps to the schema root;
 * everything else to a `$defs` entry. Both directions are checked for
 * completeness below, so this table cannot silently omit a type.
 */
const INTERFACE_TO_DEF: Readonly<Record<string, string>> = {
  HonuaMapPackage: "#",
  HonuaMapPackageSourceBinding: "sourceBinding",
  HonuaMapPackageLocator: "locator",
  HonuaMapPackageStyleRef: "styleRef",
  HonuaStyleRefLayerOverride: "styleRefLayerOverride",
  HonuaMapPackageThemeSpec: "themeSpec",
  HonuaMapPackageInitialView: "initialView",
  HonuaMapPackageLegendEntry: "legendEntry",
  HonuaMapPackagePopupBinding: "popupBinding",
  HonuaMapPackageLabelBinding: "labelBinding",
  HonuaMapPackageAttribution: "attribution",
  HonuaMapPackageWidget: "widget",
  HonuaMapPackageDependency: "dependency",
  HonuaMapPackageProvenance: "provenance",
};

/**
 * `$defs` entries with no interface of their own in `map-package.ts`, each with
 * the reason it is modelled structurally instead.
 */
const UNMAPPED_DEFS: Readonly<Record<string, string>> = {
  // `HonuaStyleRefBody` is `Record<string, HonuaStyleRefLayerOverride>`, an
  // alias rather than an interface; its value shape is checked through
  // `styleRefLayerOverride`.
  styleRefBody: "type alias over styleRefLayerOverride",
  // Delegated to @maplibre/maplibre-gl-style-spec; see the $def's description.
  mapSpec: "MapLibre style document, validated by the style spec",
};

interface ParsedInterface {
  readonly name: string;
  readonly properties: ReadonlyMap<string, { optional: boolean; literalUnion: readonly string[] | undefined }>;
  readonly hasIndexSignature: boolean;
}

function parseInterfaces(source: string): Map<string, ParsedInterface> {
  const file = ts.createSourceFile("map-package.ts", source, ts.ScriptTarget.ES2022, true);
  const interfaces = new Map<string, ParsedInterface>();
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const properties = new Map<string, { optional: boolean; literalUnion: readonly string[] | undefined }>();
    let hasIndexSignature = false;
    for (const member of statement.members) {
      if (ts.isIndexSignatureDeclaration(member)) {
        hasIndexSignature = true;
        continue;
      }
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      const name = member.name.getText(file);
      properties.set(name, {
        optional: member.questionToken !== undefined,
        literalUnion: stringLiteralUnion(member.type),
      });
    }
    interfaces.set(statement.name.text, { name: statement.name.text, properties, hasIndexSignature });
  }
  return interfaces;
}

/** Returns the members of a string-literal union type, or `undefined`. */
function stringLiteralUnion(node: ts.TypeNode | undefined): readonly string[] | undefined {
  if (node === undefined) return undefined;
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  const literals: string[] = [];
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return undefined;
    literals.push(member.literal.text);
  }
  return literals.length > 0 ? literals : undefined;
}

/** Returns the members of an exported string-literal union *type alias*. */
function parseUnionAlias(source: string, name: string): readonly string[] | undefined {
  const file = ts.createSourceFile("map-package.ts", source, ts.ScriptTarget.ES2022, true);
  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== name) continue;
    return stringLiteralUnion(statement.type);
  }
  return undefined;
}

function schemaNode(def: string): Record<string, unknown> {
  return def === "#" ? schema : schema.$defs[def];
}

const interfaces = parseInterfaces(typesSource);

describe("honua-map-package.v1 schema ↔ TypeScript drift", () => {
  test("the schema is the one the generated validator was built from", () => {
    expect(schema.$id).toBe(HONUA_MAP_PACKAGE_SCHEMA_ID);
  });

  test("the generated validator carries no runtime dependency on ajv", () => {
    // Ajv is a devDependency: the SDK ships the precompiled function only.
    // `standaloneCode` emits `require("ajv/dist/runtime/…")` for some keywords,
    // which both drags Ajv into consumers' installs and makes the ESM module
    // unloadable in Node (`ERR_AMBIGUOUS_MODULE_SYNTAX`). The generator inlines
    // those helpers; this is the guard that they stay inlined.
    const generated = fs.readFileSync(VALIDATOR_URL, "utf8");
    expect(generated).not.toMatch(/require\(/);
    expect(generated).not.toMatch(/from\s*["']ajv/);
  });

  test("the schema pins the canonical format string", () => {
    expect(schema.properties.format.const).toBe(HONUA_MAP_PACKAGE_FORMAT_V1);
  });

  test("every interface in map-package.ts is described by the schema", () => {
    const undescribed = [...interfaces.keys()].filter((name) => INTERFACE_TO_DEF[name] === undefined);
    expect(undescribed, "add a $def (and a row in INTERFACE_TO_DEF) for each new interface").toEqual([]);
  });

  test("every $def in the schema belongs to a declared type", () => {
    const orphans = Object.keys(schema.$defs).filter(
      (def) => UNMAPPED_DEFS[def] === undefined && !Object.values(INTERFACE_TO_DEF).includes(def),
    );
    expect(orphans, "a $def with no TypeScript counterpart is drift").toEqual([]);
  });

  test.each(Object.entries(INTERFACE_TO_DEF))("%s matches its schema definition", (name, def) => {
    const parsed = interfaces.get(name);
    expect(parsed, `${name} is not declared in src/runtime/map-package.ts`).toBeDefined();
    if (parsed === undefined) return;

    const node = schemaNode(def);
    const schemaProperties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;

    expect([...parsed.properties.keys()].sort(), `${name}: property names differ from ${def}`).toEqual(
      Object.keys(schemaProperties).sort(),
    );

    const schemaRequired = new Set((node.required as string[] | undefined) ?? []);
    const tsRequired = [...parsed.properties.entries()]
      .filter(([, info]) => !info.optional)
      .map(([property]) => property)
      .sort();
    expect(tsRequired, `${name}: required properties differ from ${def}`).toEqual([...schemaRequired].sort());

    // A type that accepts unknown fields must be described by a schema that
    // does too, or the runtime would preserve fields the contract rejects.
    if (parsed.hasIndexSignature) {
      expect(node.additionalProperties, `${name} has an index signature; ${def} must allow extra properties`).not.toBe(
        false,
      );
    }

    // Nested string-literal unions (widget.position, dependency.kind,
    // labelBinding.placement) must enumerate the same members.
    for (const [property, info] of parsed.properties) {
      const schemaEnum = schemaProperties[property]?.enum as string[] | undefined;
      if (schemaEnum === undefined || info.literalUnion === undefined) continue;
      expect([...info.literalUnion].sort(), `${name}.${property}: enum members differ from ${def}`).toEqual(
        [...schemaEnum].sort(),
      );
    }
  });

  test("HonuaMapPackageProtocol enumerates exactly the schema's protocols", () => {
    const union = parseUnionAlias(typesSource, "HonuaMapPackageProtocol");
    expect(union).toBeDefined();
    expect([...(union ?? [])].sort()).toEqual([...schema.$defs.sourceBinding.properties.protocol.enum].sort());
    // …and the generated projection the runtime actually reads agrees too.
    expect([...HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS].sort()).toEqual([...(union ?? [])].sort());
  });

  test("HonuaMapPackageStatus enumerates exactly the schema's statuses", () => {
    const union = parseUnionAlias(typesSource, "HonuaMapPackageStatus");
    expect(union).toBeDefined();
    expect([...(union ?? [])].sort()).toEqual([...schema.properties.status.enum].sort());
    expect([...HONUA_MAP_PACKAGE_SCHEMA_STATUSES].sort()).toEqual([...(union ?? [])].sort());
  });

  test("the mapSpec exemption is explicit and narrow", () => {
    // `mapSpec` is the only content-bearing $def without a mirrored interface.
    // If that list ever grows, this fails and the growth has to be justified.
    expect(Object.keys(UNMAPPED_DEFS).sort()).toEqual(["mapSpec", "styleRefBody"]);
    expect(schema.$defs.mapSpec.description).toContain("maplibre-gl-style-spec");
  });

  test("the schema does not mint a lifecycle or identity model (#1397 / #1398 own those)", () => {
    // #1426 deliberately stops at the artifact. Lifecycle states, content-hash
    // identity, optimistic concurrency, and actor/tenant/authorization fields
    // are projected from the honua-server composition contract; adding one here
    // would fork the model this schema exists to unify.
    const serialized = JSON.stringify(schema.properties);
    for (const forbidden of [
      "contentHash",
      "etag",
      "ifMatch",
      "revision",
      "lifecycle",
      "publicationState",
      "supersededBy",
      "tenantId",
      "actorId",
      "authorizationScope",
      "correlationId",
      "idempotencyKey",
    ]) {
      expect(serialized, `${forbidden} belongs to the server contract, not this artifact`).not.toContain(
        `"${forbidden}"`,
      );
    }
    // `status` is the one lifecycle-adjacent field, mirrored verbatim from the
    // server. It must stay exactly the five server-produced values.
    expect(schema.properties.status.enum).toEqual(["Draft", "Composing", "Ready", "Failed", "Expired"]);
  });
});
