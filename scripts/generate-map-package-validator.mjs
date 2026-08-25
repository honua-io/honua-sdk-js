#!/usr/bin/env node

/**
 * Compiles `schemas/honua-map-package.v1.json` into a zero-dependency
 * standalone Ajv validator at `src/runtime/generated/map-package-schema-validator.ts`.
 *
 * `validateMapPackage` calls that validator, so the JSON Schema is the single
 * structural source of truth for the canonical map artifact rather than a
 * parallel prose description of one (honua-sdk-js#1426). Ajv is a
 * devDependency; the SDK ships only the generated, precompiled function, which
 * is why this mirrors `scripts/generate-projjson-validator.mjs` instead of
 * validating at runtime.
 *
 *   node scripts/generate-map-package-validator.mjs           # write
 *   node scripts/generate-map-package-validator.mjs --check    # fail on drift
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { transform } from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "honua-map-package.v1.json");
const GENERATED_DIR = path.join(PROJECT_ROOT, "src", "runtime", "generated");
const OUTPUT_PATH = path.join(GENERATED_DIR, "map-package-schema-validator.ts");
const META_PATH = path.join(GENERATED_DIR, "map-package-schema-meta.ts");
const check = process.argv.includes("--check");

const schemaBytes = fs.readFileSync(SCHEMA_PATH);
const schemaSha256 = crypto.createHash("sha256").update(schemaBytes).digest("hex");
const schema = JSON.parse(schemaBytes.toString("utf8"));

if (schema.$id !== "https://honua.io/schemas/honua-map-package.v1.json") {
  throw new Error(`Unexpected $id in ${path.relative(PROJECT_ROOT, SCHEMA_PATH)}: ${schema.$id}`);
}
if (schema.properties?.format?.const !== "honua_map_package.v1") {
  throw new Error("The map-package schema must pin format to the canonical honua_map_package.v1 const");
}

// The generated file embeds a substantial portion of Ajv's standalone
// validator runtime. Prepended after esbuild so minification cannot strip it.
const THIRD_PARTY_LICENSE_NOTICE = `/*!
Third-party software notices for the generated Honua MapPackage validator

Ajv standalone validator runtime
Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/`;

/**
 * Ajv inlines the compiled schema into the standalone bundle, so the prose in
 * `schemas/honua-map-package.v1.json` — which is long on purpose, because the
 * schema is the contract document as well as the validator — would ship in
 * `/runtime`'s bundle budget. `title`, `description` and `$comment` carry no
 * validation semantics, so the compilation view drops them. Nothing else is
 * altered.
 *
 * The distinction that matters here is *schema node* versus *property name*.
 * `properties`, `patternProperties` and `$defs` are maps keyed by names chosen
 * by the contract, and a map artifact may legitimately have a property called
 * `title` — `popupBindings[].title` is one. Treating that key as an annotation
 * keyword silently deleted its `{type: "string", maxLength: 512}` subschema
 * from the compiled validator, so the generated function accepted a numeric or
 * 5000-character popup title that the published schema rejects. Recursion
 * therefore descends into those maps by value only, never inspecting their
 * keys. Keywords whose values are plain data (`enum`, `const`, `default`,
 * `examples`) are copied through untouched for the same reason.
 */
const ANNOTATION_KEYWORDS = new Set(["title", "description", "$comment"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const OPAQUE_DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

function stripAnnotations(node) {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    if (OPAQUE_DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripAnnotationsFromSchemaMap(value);
    } else {
      out[key] = stripAnnotations(value);
    }
  }
  return out;
}

/** Strips annotations from each subschema of a name-keyed map without reading its keys. */
function stripAnnotationsFromSchemaMap(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return stripAnnotations(node);
  const out = {};
  for (const [name, subschema] of Object.entries(node)) {
    out[name] = stripAnnotations(subschema);
  }
  return out;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  code: { esm: true, optimize: true, source: true },
});
const validate = ajv.compile(stripAnnotations(schema));
const standalone = inlineAjvRuntime(standaloneCode(ajv, validate));
const minified = await transform(standalone, {
  format: "esm",
  legalComments: "none",
  minify: true,
  target: "es2022",
});
const generated = [
  "// @ts-nocheck",
  THIRD_PARTY_LICENSE_NOTICE,
  `/* Generated from schemas/honua-map-package.v1.json; source sha256:${schemaSha256}.`,
  '   Do not edit. Run "npm run map-package-schema:generate" after changing the schema. */',
  minified.code.trim(),
  "",
].join("\n");

verifyThirdPartyNotice(generated, "newly generated validator");

// A second, tiny artifact: the enumerations the runtime needs to reason about
// as *values* rather than as a validation pass. Emitting them here is what
// lets `map-package-validation.ts` stop hand-maintaining a protocol list that
// could silently disagree with the schema, and lets the drift test compare the
// schema's enums against the TypeScript unions.
const meta = [
  "// Generated from schemas/honua-map-package.v1.json. Do not edit.",
  '// Run "npm run map-package-schema:generate" after changing the schema.',
  "",
  "/** `$id` of the schema this projection was generated from. */",
  `export const HONUA_MAP_PACKAGE_SCHEMA_ID = ${JSON.stringify(schema.$id)} as const;`,
  "",
  "/** sha256 of the schema bytes, so a drifted projection is identifiable. */",
  `export const HONUA_MAP_PACKAGE_SCHEMA_SHA256 = ${JSON.stringify(schemaSha256)} as const;`,
  "",
  "/** Every `SourceBinding.protocol` value the schema admits. */",
  `export const HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS = ${JSON.stringify(
    schema.$defs.sourceBinding.properties.protocol.enum,
  )} as const;`,
  "",
  "/** Every `status` value the schema admits (server-produced; see the schema). */",
  `export const HONUA_MAP_PACKAGE_SCHEMA_STATUSES = ${JSON.stringify(schema.properties.status.enum)} as const;`,
  "",
  "/** Top-level properties the schema requires. */",
  `export const HONUA_MAP_PACKAGE_SCHEMA_REQUIRED = ${JSON.stringify(schema.required)} as const;`,
  "",
].join("\n");

if (check) {
  let stale = false;
  const existing = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : undefined;
  if (existing !== undefined) verifyThirdPartyNotice(existing, path.relative(PROJECT_ROOT, OUTPUT_PATH));
  if (existing !== generated) stale = true;
  const existingMeta = fs.existsSync(META_PATH) ? fs.readFileSync(META_PATH, "utf8") : undefined;
  if (existingMeta !== meta) stale = true;
  if (stale) {
    process.stderr.write(
      'Generated MapPackage schema artifacts are stale. Run "npm run map-package-schema:generate" and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`mapPackageSchemaValidator=ok sha256:${schemaSha256}\n`);
} else {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, generated);
  fs.writeFileSync(META_PATH, meta);
  process.stdout.write(
    `wrote ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} + ${path.relative(
      PROJECT_ROOT,
      META_PATH,
    )} sha256:${schemaSha256}\n`,
  );
}

/**
 * Inlines the pieces of Ajv's runtime that `standaloneCode` would otherwise
 * reach for with a bare `require("ajv/dist/runtime/…")`.
 *
 * Two independent reasons this has to happen, either of which alone is fatal:
 *
 *  1. **Ajv must never become a runtime dependency.** It is a devDependency;
 *     the SDK ships only the precompiled function. A surviving `require` would
 *     make every consumer of `@honua/sdk-js/runtime` need Ajv installed.
 *  2. **The emitted module is ESM.** Mixing `require` into a file that also
 *     uses top-level `export` makes Node refuse to load it at all
 *     (`ERR_AMBIGUOUS_MODULE_SYNTAX`), which is how this was caught — the split
 *     `@honua/app-platform` package failed to import at verification time.
 *
 * `ucs2length` is the only runtime helper this schema pulls in (it backs the
 * `minLength`/`maxLength` bounds; the PROJJSON schema next door has none, which
 * is why `generate-projjson-validator.mjs` never had to do this). The body
 * below is Ajv's, MIT-licensed and covered by the notice this file prepends.
 * Any *other* `require` is a hard failure rather than something to paper over:
 * a new one means the schema started using a keyword whose helper also has to
 * be inlined deliberately.
 */
function inlineAjvRuntime(code) {
  const UCS2LENGTH = [
    "function ajvUcs2length(str) {",
    "  const len = str.length;",
    "  let length = 0;",
    "  let pos = 0;",
    "  let value;",
    "  while (pos < len) {",
    "    length++;",
    "    value = str.charCodeAt(pos++);",
    "    if (value >= 0xd800 && value <= 0xdbff && pos < len) {",
    "      value = str.charCodeAt(pos);",
    "      if ((value & 0xfc00) === 0xdc00) pos++;",
    "    }",
    "  }",
    "  return length;",
    "}",
  ].join("\n");

  let inlined = code;
  if (inlined.includes('require("ajv/dist/runtime/ucs2length").default')) {
    inlined = `${UCS2LENGTH}\n${inlined.replaceAll(
      'require("ajv/dist/runtime/ucs2length").default',
      "ajvUcs2length",
    )}`;
  }

  const leftover = inlined.match(/require\((?:"|')[^"']*(?:"|')\)/g);
  if (leftover) {
    throw new Error(
      `Generated validator still requires Ajv runtime helpers at import time: ${[...new Set(leftover)].join(
        ", ",
      )}. Inline them in inlineAjvRuntime() — the SDK must not depend on ajv at runtime.`,
    );
  }
  return inlined;
}

function verifyThirdPartyNotice(contents, label) {
  const required = [
    "Copyright (c) 2015-2021 Evgeny Poberezkin",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
  ];
  if (!contents.startsWith(`// @ts-nocheck\n${THIRD_PARTY_LICENSE_NOTICE}\n`)) {
    throw new Error(`${label} does not carry the complete generated-validator third-party license notice`);
  }
  for (const fragment of required) {
    if (!contents.includes(fragment)) {
      throw new Error(`${label} is missing required third-party license text: ${fragment}`);
    }
  }
}
