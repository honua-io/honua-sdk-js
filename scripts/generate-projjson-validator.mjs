#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { transform } from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "schemas", "projjson-v0.7.schema.json");
const PROVENANCE_PATH = path.join(PROJECT_ROOT, "schemas", "projjson-v0.7.provenance.json");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "src", "contract", "generated", "projjson-v0.7-crs-validator.ts");
const check = process.argv.includes("--check");

const schemaBytes = fs.readFileSync(SCHEMA_PATH);
const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
const actualSha256 = crypto.createHash("sha256").update(schemaBytes).digest("hex");
if (actualSha256 !== provenance.sha256) {
  throw new Error(
    `Pinned PROJJSON schema digest mismatch: expected ${provenance.sha256}, received ${actualSha256}`,
  );
}

const officialSchema = JSON.parse(schemaBytes.toString("utf8"));
if (officialSchema.$id !== provenance.source || officialSchema.$schema !== provenance.draft) {
  throw new Error("Pinned PROJJSON schema identity does not match its provenance record");
}

// This notice is prepended after esbuild so neither minification nor
// `legalComments` can strip it. The generated validator embeds substantial
// portions of both the PROJJSON schema and Ajv's standalone validator runtime.
const THIRD_PARTY_LICENSE_NOTICE = `/*!
Third-party software notices for the generated PROJJSON validator

PROJJSON schema
Copyright (c) ${provenance.copyright}

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

const crsSchema = {
  $schema: officialSchema.$schema,
  $id: "https://honua.io/schemas/projjson-v0.7-crs.json",
  $ref: "#/definitions/crs",
  definitions: officialSchema.definitions,
};
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  code: { esm: true, optimize: true, source: true },
});
const validate = ajv.compile(crsSchema);
const standalone = standaloneCode(ajv, validate);
const minified = await transform(standalone, {
  format: "esm",
  legalComments: "none",
  minify: true,
  target: "es2022",
});
const generated = [
  "// @ts-nocheck",
  THIRD_PARTY_LICENSE_NOTICE,
  `/* Generated from PROJJSON v0.7 #/definitions/crs; source sha256:${actualSha256}. */`,
  minified.code.trim(),
  "",
].join("\n");

verifyThirdPartyNotice(generated, "newly generated validator");

if (check) {
  const existing = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : undefined;
  if (existing !== undefined) verifyThirdPartyNotice(existing, path.relative(PROJECT_ROOT, OUTPUT_PATH));
  if (existing !== generated) {
    process.stderr.write(
      'Generated PROJJSON validator is stale. Run "npm run projjson:generate" and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`projjsonValidator=ok sha256:${actualSha256}\n`);
} else {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, generated);
  process.stdout.write(`wrote ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} sha256:${actualSha256}\n`);
}

function verifyThirdPartyNotice(contents, label) {
  const required = [
    `Copyright (c) ${provenance.copyright}`,
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
