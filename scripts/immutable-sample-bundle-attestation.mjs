#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  PUBLISHED_LIVE_SAMPLE_POLICY,
  SAMPLE_BUNDLE_STATIC_SMOKE_JOURNEYS,
} from "./build-sample-bundles.mjs";
import { lockfileDependencyDigest } from "./lib/lockfile-pin.mjs";

export const WORKFLOW_PATH =
  ".github/workflows/publish-content-addressed-sample-bundles.yml";
export const NODE_VERSION = "20.19.0";
// The dependency digest of `package-lock.json` that the privileged publish job
// is allowed to publish for -- `lockfileDependencyDigest`, not a digest of the
// file's bytes. This is the bound copy: the authoritative one is the
// `EXPECTED_LOCKFILE_SHA256` env value in the workflow above, and
// `validateWorkflowDocument` asserts they are the same string, so neither can
// move without the other. Only a human editing a real dependency change moves
// it: nothing in CI can, because `GITHUB_TOKEN` cannot commit to
// `.github/workflows/**` (#1357).
export const EXPECTED_LOCKFILE_SHA256 =
  "d949436651e3541a7d757836e08e65d54d463197c463220b52dd9b476566af6e";
export const ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact:
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  downloadArtifact:
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  attestBuildProvenance:
    "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
});
export const ACTION_COMMITS = new Map(
  Object.values(ACTIONS).map((value) => {
    const [repository, commit] = value.split("@");
    return [repository, commit];
  }),
);
export const RUN_BODY_SHA256 = Object.freeze({
  "build-and-smoke/Gate exact current trunk":
    "a7363cb644c8da6c1b30cb30f31b273b7064f7ae85b0258b23dd8e19c2383d11",
  "build-and-smoke/Install source A":
    "9db3f780def6105eee3cc930de4d0982607760820fddaa3facdd3813ccb40628",
  "build-and-smoke/Install source B":
    "9db3f780def6105eee3cc930de4d0982607760820fddaa3facdd3813ccb40628",
  "build-and-smoke/Build, verify, pack, and smoke source A":
    "6cbbb6c9db8279804d1cf42f23c0d2a713dd6035b6a994478577200d1e598bb2",
  "build-and-smoke/Build, verify, and pack source B":
    "7bb1b23018634a3f35b4b08b6fb0e44cf97b6bd24737c7d489fb7a8b752431d6",
  "build-and-smoke/Compare independent builds":
    "bea3664e935a4bab051043269ff931b6d447cfb3f103db9904217fe1a38ee908",
  "build-and-smoke/Create deterministic and run receipts":
    "85c2488b7e28eee4e6ed9cccc0734925fe68b8a641e5a0d88a63cb28827862cf",
  "build-and-smoke/Run governance tests and policy":
    "31c9adb88c3990cf2bb12d3fd0c237683cceb86f6092353aa7943c9e614230ff",
  "build-and-smoke/Stage transfer":
    "b6a12a3064dd6c7812fbd2aa8f6e24249e8766a230c8b098fe468e30f6603de9",
  "attest-and-publish/Validate all bytes before tokens":
    "1123caba9863f93123a946ed9d03be4863a4c1f53ed8d30cb9e946d61cc09a31",
  "attest-and-publish/Gate current trunk and immutable releases":
    "9fb1bf3829695d33d86aaf7834420aed11dfe6cf78dc65515473e093505c1c71",
  "attest-and-publish/Create or accept exact immutable release":
    "f72f5efcc7a13db37e969a6135ecba8fbb35e5b49a641ad4421f466301044ca0",
  "attest-and-publish/Redownload, compare, and verify attestations":
    "c67457a520966d46bdfad17260782af7c450a7de396b7177a4ff22bd94fd3c54",
});

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAMPLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL = /[\0-\x1f\x7f]/u;
const MANIFEST_NAME = "sample-bundles.v2.json";
const ARCHIVE_NAME = "sample-bundles.tar.gz";
const DETERMINISTIC_NAME = "sample-bundles-attestation.v1.json";
const RUN_NAME = "sample-bundles-run-attestation.v1.json";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function canonicalGzip(bytes) {
  const blocks = [];
  if (bytes.length === 0) blocks.push(Buffer.from([1, 0, 0, 0xff, 0xff]));
  for (let offset = 0; offset < bytes.length; offset += 65_535) {
    const length = Math.min(65_535, bytes.length - offset);
    const block = Buffer.alloc(5 + length);
    block[0] = offset + length === bytes.length ? 1 : 0;
    block.writeUInt16LE(length, 1);
    block.writeUInt16LE(0xffff ^ length, 3);
    bytes.copy(block, 5, offset, offset + length);
    blocks.push(block);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]),
    ...blocks,
    trailer,
  ]);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseUniqueJson(input, label = "JSON document") {
  const source =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  let offset = 0;

  const fail = (message) => {
    throw new Error(`${label} ${message} at byte ${offset}`);
  };
  const whitespace = () => {
    while (
      source[offset] === " " ||
      source[offset] === "\t" ||
      source[offset] === "\r" ||
      source[offset] === "\n"
    )
      offset += 1;
  };
  const digit = (value) => value >= "0" && value <= "9";
  const hexDigit = (value) =>
    digit(value) ||
    (value >= "a" && value <= "f") ||
    (value >= "A" && value <= "F");

  const parseString = () => {
    const start = offset;
    invariant(
      source[offset] === '"',
      `${label} string must start with a quote`,
    );
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (character === '"') return JSON.parse(source.slice(start, offset));
      if (character === "\\") {
        const escape = source[offset];
        offset += 1;
        if (escape === "u") {
          for (let index = 0; index < 4; index += 1) {
            if (!hexDigit(source[offset])) fail("contains an invalid escape");
            offset += 1;
          }
        } else if (
          !['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)
        ) {
          fail("contains an invalid escape");
        }
      } else if (character.charCodeAt(0) <= 0x1f) {
        fail("contains an unescaped control character");
      }
    }
    fail("contains an unterminated string");
  };

  const parseNumber = () => {
    const start = offset;
    if (source[offset] === "-") offset += 1;
    if (source[offset] === "0") {
      offset += 1;
    } else {
      if (!digit(source[offset]) || source[offset] === "0")
        fail("contains an invalid number");
      while (digit(source[offset])) offset += 1;
    }
    if (source[offset] === ".") {
      offset += 1;
      if (!digit(source[offset])) fail("contains an invalid fraction");
      while (digit(source[offset])) offset += 1;
    }
    if (source[offset] === "e" || source[offset] === "E") {
      offset += 1;
      if (source[offset] === "+" || source[offset] === "-") offset += 1;
      if (!digit(source[offset])) fail("contains an invalid exponent");
      while (digit(source[offset])) offset += 1;
    }
    return Number(source.slice(start, offset));
  };

  const parseValue = (depth = 0) => {
    invariant(depth <= 256, `${label} is too deeply nested`);
    whitespace();
    if (source[offset] === '"') return parseString();
    if (source[offset] === "{") {
      offset += 1;
      whitespace();
      const result = {};
      const members = new Set();
      if (source[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        if (source[offset] !== '"') fail("contains an invalid object key");
        const key = parseString();
        if (members.has(key))
          throw new Error(
            `${label} contains duplicate key ${JSON.stringify(key)}`,
          );
        members.add(key);
        whitespace();
        if (source[offset] !== ":") fail("is missing an object colon");
        offset += 1;
        const value = parseValue(depth + 1);
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return result;
        }
        if (source[offset] !== ",") fail("is missing an object comma");
        offset += 1;
        whitespace();
      }
      fail("contains an unterminated object");
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      const result = [];
      if (source[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < source.length) {
        result.push(parseValue(depth + 1));
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return result;
        }
        if (source[offset] !== ",") fail("is missing an array comma");
        offset += 1;
      }
      fail("contains an unterminated array");
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return value;
      }
    }
    if (source[offset] === "-" || digit(source[offset])) return parseNumber();
    fail("contains an invalid value");
  };

  const value = parseValue();
  whitespace();
  if (offset !== source.length) fail("contains trailing content");
  return value;
}

function object(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} keyset drifted`,
  );
}

function allowedKeys(value, required, allowed, label) {
  object(value, label);
  invariant(
    required.every((key) => Object.hasOwn(value, key)),
    `${label} is missing a required key`,
  );
  invariant(
    Object.keys(value).every((key) => allowed.includes(key)),
    `${label} contains an unexpected key`,
  );
}

function nonemptyString(value, label, maximum = 4096) {
  invariant(
    typeof value === "string" && value.length > 0 && value.length <= maximum,
    `${label} must be a bounded string`,
  );
  invariant(!CONTROL.test(value), `${label} contains a control character`);
}

function integer(value, minimum, maximum, label) {
  invariant(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} is outside its integer range`,
  );
}

function safePath(value, label = "path") {
  nonemptyString(value, label, 255);
  invariant(
    !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value),
    `${label} is not relative POSIX`,
  );
  const parts = value.replace(/\/$/u, "").split("/");
  invariant(
    parts.every((part) => part && part !== "." && part !== ".."),
    `${label} traverses`,
  );
  return value;
}

function parseArguments(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(
      key?.startsWith("--") && value !== undefined,
      `invalid argument sequence at ${key ?? "end"}`,
    );
    invariant(!values.has(key.slice(2)), `duplicate argument ${key}`);
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function required(values, name) {
  const value = values.get(name);
  invariant(value, `--${name} is required`);
  return value;
}

export function validateManifest(manifest, { sourceCommit, lockfileSha256 }) {
  exactKeys(
    manifest,
    ["format", "schemaVersion", "build", "samples", "excluded"],
    "manifest",
  );
  invariant(
    manifest.format === "honua.sdk.sample-bundles.v2" &&
      manifest.schemaVersion === 2,
    "manifest identity drifted",
  );
  exactKeys(manifest.build, ["node", "lockfileSha256"], "manifest.build");
  nonemptyString(manifest.build.node, "manifest.build.node", 64);
  invariant(
    manifest.build.lockfileSha256 === lockfileSha256 &&
      SHA256.test(lockfileSha256),
    "manifest lockfile digest drifted",
  );
  invariant(
    Array.isArray(manifest.samples) &&
      manifest.samples.length >= 1 &&
      manifest.samples.length <= 100,
    "manifest sample count is invalid",
  );
  invariant(
    Array.isArray(manifest.excluded) && manifest.excluded.length <= 1000,
    "manifest excluded set is invalid",
  );

  const samples = new Map();
  const files = new Map();
  let previousId = "";
  for (const sample of manifest.samples) {
    exactKeys(
      sample,
      [
        "id",
        "entrypoint",
        "dataMode",
        "configDefaults",
        "runtimeHosting",
        "runnability",
        "hostFixtureRoutes",
        "support",
        "lifecycle",
        "builtFrom",
        "files",
      ],
      "manifest sample",
    );
    invariant(
      SAMPLE_ID.test(sample.id) && compareUtf8(sample.id, previousId) > 0,
      "manifest sample ids are invalid, duplicated, or unordered",
    );
    previousId = sample.id;
    invariant(
      sample.entrypoint === "index.html",
      `${sample.id}: entrypoint drifted`,
    );
    invariant(
      [
        "self-contained",
        "same-origin-fixture-service",
        "external-live-endpoint",
      ].includes(sample.runtimeHosting),
      `${sample.id}: runtime hosting is invalid`,
    );
    const expectedRunnability = {
      "self-contained": "standalone",
      "same-origin-fixture-service": "requires-host-fixture-service",
      "external-live-endpoint": "requires-live-endpoint",
    }[sample.runtimeHosting];
    invariant(
      sample.runnability === expectedRunnability,
      `${sample.id}: runnability drifted`,
    );
    object(sample.configDefaults, `${sample.id}.configDefaults`);
    invariant(
      Object.entries(sample.configDefaults).every(
        ([key, value]) =>
          /^[A-Z][A-Z0-9_]*$/u.test(key) &&
          (value === null || typeof value === "string"),
      ),
      `${sample.id}: config defaults are invalid`,
    );
    invariant(
      Array.isArray(sample.hostFixtureRoutes),
      `${sample.id}: fixture routes are invalid`,
    );
    invariant(
      sample.hostFixtureRoutes.every(
        (route) =>
          typeof route === "string" &&
          route.startsWith("/") &&
          !CONTROL.test(route),
      ),
      `${sample.id}: fixture route is invalid`,
    );
    exactKeys(
      sample.support,
      ["tier", "track", "validationProfile"],
      `${sample.id}.support`,
    );
    Object.entries(sample.support).forEach(([key, value]) =>
      nonemptyString(value, `${sample.id}.support.${key}`, 128),
    );
    allowedKeys(
      sample.lifecycle,
      ["state", "reason"],
      ["state", "reason", "replacement", "targetRelease"],
      `${sample.id}.lifecycle`,
    );
    nonemptyString(sample.lifecycle.state, `${sample.id}.lifecycle.state`, 64);
    invariant(
      sample.lifecycle.reason === null ||
        typeof sample.lifecycle.reason === "string",
      `${sample.id}: lifecycle reason is invalid`,
    );
    exactKeys(
      sample.builtFrom,
      ["commit", "packageVersion"],
      `${sample.id}.builtFrom`,
    );
    invariant(
      sample.builtFrom.commit === sourceCommit && SHA.test(sourceCommit),
      `${sample.id}: source commit drifted`,
    );
    nonemptyString(
      sample.builtFrom.packageVersion,
      `${sample.id}.builtFrom.packageVersion`,
      64,
    );
    invariant(
      Array.isArray(sample.files) &&
        sample.files.length > 0 &&
        sample.files.length <= 10000,
      `${sample.id}: files are invalid`,
    );
    let previousPath = "";
    for (const file of sample.files) {
      exactKeys(
        file,
        ["path", "bytes", "sha256", "integrity", "mediaType"],
        `${sample.id} file`,
      );
      safePath(file.path, `${sample.id} file path`);
      invariant(
        compareUtf8(file.path, previousPath) > 0,
        `${sample.id}: file paths are duplicated or unordered`,
      );
      previousPath = file.path;
      integer(file.bytes, 0, 1_000_000_000, `${sample.id}/${file.path} bytes`);
      invariant(
        SHA256.test(file.sha256),
        `${sample.id}/${file.path}: SHA-256 is invalid`,
      );
      invariant(
        file.integrity ===
          `sha256-${Buffer.from(file.sha256, "hex").toString("base64")}`,
        `${sample.id}/${file.path}: integrity drifted`,
      );
      nonemptyString(
        file.mediaType,
        `${sample.id}/${file.path}: media type`,
        128,
      );
      const archivePath = `${sample.id}/${file.path}`;
      invariant(
        !files.has(archivePath),
        `duplicate archive path ${archivePath}`,
      );
      files.set(archivePath, file);
    }
    samples.set(sample.id, sample);
  }

  for (const excluded of manifest.excluded) {
    exactKeys(excluded, ["id", "category", "reason"], "excluded sample");
    invariant(
      SAMPLE_ID.test(excluded.id) && !samples.has(excluded.id),
      "excluded sample id is invalid or published",
    );
    nonemptyString(excluded.category, `${excluded.id}.category`, 128);
    nonemptyString(excluded.reason, `${excluded.id}.reason`, 8192);
  }
  return { samples, files };
}

function validateJsonTree(value, label, depth = 0) {
  invariant(depth <= 12, `${label} is too deeply nested`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    invariant(
      Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
      `${label} number is invalid`,
    );
    return;
  }
  if (typeof value === "string") {
    invariant(
      value.length <= 8192 && !CONTROL.test(value),
      `${label} string is invalid`,
    );
    return;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= 1000, `${label} array is too large`);
    value.forEach((entry, index) =>
      validateJsonTree(entry, `${label}[${index}]`, depth + 1),
    );
    return;
  }
  object(value, label);
  invariant(Object.keys(value).length <= 200, `${label} object is too large`);
  for (const [key, entry] of Object.entries(value)) {
    invariant(
      /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(key),
      `${label} key is invalid`,
    );
    validateJsonTree(entry, `${label}.${key}`, depth + 1);
  }
}

function validateCoverageSmokeJourney(value, policy, label) {
  exactKeys(
    value,
    [
      "ogc",
      "wcs",
      "requestProof",
      "beforeDispose",
      "disposal",
      "visibleEvidence",
    ],
    label,
  );
  for (const protocol of ["ogc", "wcs"]) {
    const proof = value[protocol];
    exactKeys(
      proof,
      ["mounted", "cancellation", "degradation"],
      `${label}.${protocol}`,
    );
    exactKeys(
      proof.mounted,
      ["protocol", "sourceId", "sourceMounted", "layerMounted"],
      `${label}.${protocol}.mounted`,
    );
    invariant(
      JSON.stringify(proof.mounted) ===
        JSON.stringify({
          protocol,
          sourceId: policy[`${protocol}SourceId`],
          sourceMounted: true,
          layerMounted: true,
        }),
      `${label}.${protocol}.mounted drifted`,
    );
    exactKeys(
      proof.cancellation,
      ["status", "activeProtocol"],
      `${label}.${protocol}.cancellation`,
    );
    invariant(
      proof.cancellation.status === "cancelled" &&
        proof.cancellation.activeProtocol === protocol,
      `${label}.${protocol}.cancellation drifted`,
    );
    exactKeys(
      proof.degradation,
      ["status", "code", "activeProtocol"],
      `${label}.${protocol}.degradation`,
    );
    invariant(
      proof.degradation.status === "degraded" &&
        proof.degradation.code === "InvalidParameterValue" &&
        proof.degradation.activeProtocol === protocol,
      `${label}.${protocol}.degradation drifted`,
    );
  }
  exactKeys(
    value.requestProof,
    [
      "allVirtualFixture",
      "ogcSuccess",
      "ogcCancellation",
      "ogcDegradation",
      "wcsSuccess",
      "wcsCancellation",
      "wcsDegradation",
    ],
    `${label}.requestProof`,
  );
  invariant(
    Object.values(value.requestProof).every((entry) => entry === true),
    `${label}.requestProof drifted`,
  );
  exactKeys(
    value.beforeDispose,
    [
      "ready",
      "phase",
      "fixtureDigest",
      "ogcByteLength",
      "wcsByteLength",
      "imageWidth",
      "imageHeight",
      "centerPixelValue",
      "centerPixelColor",
      "cancellationCount",
      "degradationCount",
      "requestCount",
      "objectUrlsUnique",
      "switchedObjectUrlRevoked",
      "activeObjectUrl",
      "protocol",
      "sourceId",
      "sourceMounted",
      "layerMounted",
    ],
    `${label}.beforeDispose`,
  );
  const before = value.beforeDispose;
  nonemptyString(
    before.activeObjectUrl,
    `${label}.beforeDispose.activeObjectUrl`,
    2048,
  );
  invariant(
    before.activeObjectUrl.startsWith("blob:") &&
      before.ready === true &&
      before.phase === "degraded" &&
      before.fixtureDigest === policy.fixtureDigest &&
      before.ogcByteLength === policy.fixtureByteLength &&
      before.wcsByteLength === policy.fixtureByteLength &&
      before.imageWidth === policy.imageWidth &&
      before.imageHeight === policy.imageHeight &&
      before.centerPixelValue === policy.centerPixelValue &&
      JSON.stringify(before.centerPixelColor) ===
        JSON.stringify(policy.centerPixelColor) &&
      before.cancellationCount === 2 &&
      before.degradationCount === 2 &&
      before.requestCount === 12 &&
      before.objectUrlsUnique === true &&
      before.switchedObjectUrlRevoked === true &&
      before.protocol === "wcs" &&
      before.sourceId === policy.wcsSourceId &&
      before.sourceMounted === true &&
      before.layerMounted === true,
    `${label}.beforeDispose drifted`,
  );
  exactKeys(
    value.disposal,
    [
      "disposed",
      "ready",
      "sourceId",
      "activeObjectUrl",
      "sourceCleanupVerified",
      "mapRemoved",
      "canvasCount",
      "revokedBothObjectUrls",
      "revokedObjectUrlCount",
    ],
    `${label}.disposal`,
  );
  invariant(
    JSON.stringify(value.disposal) ===
      JSON.stringify({
        disposed: true,
        ready: false,
        sourceId: null,
        activeObjectUrl: null,
        sourceCleanupVerified: true,
        mapRemoved: true,
        canvasCount: 0,
        revokedBothObjectUrls: true,
        revokedObjectUrlCount: 2,
      }),
    `${label}.disposal drifted`,
  );
  exactKeys(
    value.visibleEvidence,
    ["canvasCount", "legend", "pixel"],
    `${label}.visibleEvidence`,
  );
  nonemptyString(
    value.visibleEvidence.legend,
    `${label}.visibleEvidence.legend`,
    4096,
  );
  invariant(
    value.visibleEvidence.canvasCount === 1 &&
      value.visibleEvidence.legend.includes(policy.legendMinText) &&
      value.visibleEvidence.legend.includes(policy.legendMaxText) &&
      value.visibleEvidence.pixel === policy.pixelText,
    `${label}.visibleEvidence drifted`,
  );
}

export function normalizeSmoke(smoke, manifest, sourceCommit, sourceDateEpoch) {
  exactKeys(
    smoke,
    ["format", "generatedAt", "manifest", "summary", "results"],
    "smoke receipt",
  );
  invariant(
    smoke.format === "honua.sdk.sample-bundle-browser-smoke.v1",
    "smoke receipt format drifted",
  );
  invariant(
    smoke.generatedAt ===
      new Date(Number(sourceDateEpoch) * 1000).toISOString(),
    "smoke timestamp is not source-derived",
  );
  exactKeys(
    smoke.manifest,
    ["format", "schemaVersion", "commit"],
    "smoke manifest",
  );
  invariant(
    smoke.manifest.format === manifest.format &&
      smoke.manifest.schemaVersion === 2 &&
      smoke.manifest.commit === sourceCommit,
    "smoke source manifest drifted",
  );
  exactKeys(smoke.summary, ["total", "passed", "failed"], "smoke summary");
  const expectedSamples = manifest.samples.filter((sample) =>
    ["standalone", "requires-live-endpoint"].includes(sample.runnability),
  );
  invariant(
    Array.isArray(smoke.results) &&
      smoke.results.length === expectedSamples.length,
    "smoke result count drifted",
  );
  integer(
    smoke.summary.total,
    expectedSamples.length,
    expectedSamples.length,
    "smoke total",
  );
  integer(
    smoke.summary.passed,
    expectedSamples.length,
    expectedSamples.length,
    "smoke passed",
  );
  integer(smoke.summary.failed, 0, 0, "smoke failed");

  const normalized = [];
  for (let index = 0; index < expectedSamples.length; index += 1) {
    const sample = expectedSamples[index];
    const result = smoke.results[index];
    exactKeys(
      result,
      [
        "id",
        "title",
        "passed",
        "requestCount",
        "network",
        "staticJourney",
        "liveProbe",
        "failures",
        "screenshot",
      ],
      `${sample.id} smoke result`,
    );
    invariant(
      result.id === sample.id && result.passed === true,
      `${sample.id}: smoke order or result drifted`,
    );
    nonemptyString(result.title, `${sample.id}: title`, 512);
    integer(result.requestCount, 1, 10000, `${sample.id}: requestCount`);
    exactKeys(
      result.network,
      ["offOriginRequestCount", "clientErrorResponseCount"],
      `${sample.id}.network`,
    );
    integer(
      result.network.offOriginRequestCount,
      0,
      0,
      `${sample.id}: off-origin requests`,
    );
    integer(
      result.network.clientErrorResponseCount,
      0,
      0,
      `${sample.id}: client-error responses`,
    );
    invariant(
      Array.isArray(result.failures) &&
        result.failures.length === 0 &&
        result.screenshot === null,
      `${sample.id}: smoke failure evidence drifted`,
    );

    const journeyPolicy = SAMPLE_BUNDLE_STATIC_SMOKE_JOURNEYS.get(sample.id);
    if (journeyPolicy) {
      object(result.staticJourney, `${sample.id}.staticJourney`);
      validateJsonTree(result.staticJourney, `${sample.id}.staticJourney`);
      if (journeyPolicy.kind !== "coverage") {
        exactKeys(
          result.staticJourney,
          ["resultReady", "canvasCount", "sourceFeatureCount", "markerCount"],
          `${sample.id}.staticJourney`,
        );
        invariant(
          result.staticJourney.resultReady === true,
          `${sample.id}: static journey is not ready`,
        );
        for (const key of ["canvasCount", "sourceFeatureCount", "markerCount"])
          integer(result.staticJourney[key], 1, 10000, `${sample.id}.${key}`);
      } else {
        validateCoverageSmokeJourney(
          result.staticJourney,
          journeyPolicy,
          `${sample.id}.staticJourney`,
        );
      }
    } else {
      invariant(
        result.staticJourney === null,
        `${sample.id}: unexpected static journey proof`,
      );
    }

    const livePolicy = PUBLISHED_LIVE_SAMPLE_POLICY.get(sample.id);
    if (livePolicy) {
      exactKeys(
        result.liveProbe,
        ["passed", "origin", "status", "semantic", "featureCount"],
        `${sample.id}.liveProbe`,
      );
      invariant(
        result.liveProbe.passed === true,
        `${sample.id}: live probe failed`,
      );
      invariant(
        result.liveProbe.origin === livePolicy.allowedOrigins[0],
        `${sample.id}: live origin drifted`,
      );
      integer(result.liveProbe.status, 200, 299, `${sample.id}: live status`);
      invariant(
        result.liveProbe.semantic === livePolicy.semanticProbe.kind,
        `${sample.id}: live semantic drifted`,
      );
      integer(
        result.liveProbe.featureCount,
        livePolicy.semanticProbe.minimumFeatures,
        1_000_000,
        `${sample.id}: live feature count`,
      );
    } else {
      invariant(
        result.liveProbe === null,
        `${sample.id}: unexpected live probe`,
      );
    }
    normalized.push({
      id: sample.id,
      passed: true,
      requestCount: result.requestCount,
      network: { offOriginRequestCount: 0, clientErrorResponseCount: 0 },
      staticJourney: {
        policy: journeyPolicy
          ? (journeyPolicy.kind ?? "interaction")
          : "not-required",
        status: journeyPolicy ? "passed" : "not-required",
      },
      liveProbe: livePolicy
        ? {
            policy: livePolicy.semanticProbe.kind,
            status: "passed",
            origin: livePolicy.allowedOrigins[0],
            httpStatus: result.liveProbe.status,
            featureCount: result.liveProbe.featureCount,
          }
        : { policy: "not-required", status: "not-required" },
    });
  }
  return {
    total: expectedSamples.length,
    passed: expectedSamples.length,
    failed: 0,
    results: normalized,
  };
}

function parseOctal(field, label) {
  invariant(
    field.length > 1 && field.at(-1) === 0,
    `${label} is not canonical NUL-terminated octal`,
  );
  const text = field.subarray(0, -1).toString("ascii");
  invariant(/^[0-7]+$/u.test(text), `${label} is not octal`);
  const value = Number.parseInt(text, 8);
  invariant(Number.isSafeInteger(value), `${label} overflows`);
  return value;
}

function cString(field, label) {
  const firstNul = field.indexOf(0);
  const end = firstNul === -1 ? field.length : firstNul;
  invariant(
    firstNul === -1 || field.subarray(firstNul).every((byte) => byte === 0),
    `${label} has embedded data after NUL`,
  );
  const value = field.subarray(0, end).toString("utf8");
  invariant(!CONTROL.test(value), `${label} contains control characters`);
  return value;
}

function parentDirectories(paths) {
  const result = new Set();
  for (const item of paths) {
    const parts = item.split("/");
    for (let index = 1; index < parts.length; index += 1)
      result.add(`${parts.slice(0, index).join("/")}/`);
  }
  return result;
}

function splitUstarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  const separators = [...value.matchAll(/\//gu)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const prefix = value.slice(0, separators[index]);
    const name = value.slice(separators[index] + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return { name, prefix };
  }
  throw new Error(`archive path cannot be represented as ustar: ${value}`);
}

function putCanonicalString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  invariant(bytes.length <= length, `ustar field overflow: ${value}`);
  bytes.copy(header, offset);
}

function putCanonicalOctal(header, offset, length, value) {
  integer(value, 0, Number.MAX_SAFE_INTEGER, "ustar numeric field");
  const encoded = value.toString(8).padStart(length - 1, "0");
  invariant(encoded.length === length - 1, "ustar numeric field overflow");
  putCanonicalString(header, offset, length - 1, encoded);
  header[offset + length - 1] = 0;
}

function canonicalTarHeader(archivePath, type, size, mtime) {
  const logicalPath = type === "5" ? archivePath.slice(0, -1) : archivePath;
  const { name, prefix } = splitUstarPath(logicalPath);
  const header = Buffer.alloc(512);
  putCanonicalString(header, 0, 100, name);
  putCanonicalOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  putCanonicalOctal(header, 108, 8, 0);
  putCanonicalOctal(header, 116, 8, 0);
  putCanonicalOctal(header, 124, 12, size);
  putCanonicalOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  putCanonicalString(header, 257, 6, "ustar");
  putCanonicalString(header, 263, 2, "00");
  putCanonicalOctal(header, 329, 8, 0);
  putCanonicalOctal(header, 337, 8, 0);
  putCanonicalString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putCanonicalString(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function reconstructCanonicalTar(entries, contents, sourceDateEpoch) {
  const blocks = [];
  for (const entry of entries) {
    const content =
      entry.type === "0" ? contents.get(entry.path) : Buffer.alloc(0);
    invariant(content, `${entry.path}: archive content is missing`);
    blocks.push(
      canonicalTarHeader(
        entry.path,
        entry.type,
        content.length,
        Number(sourceDateEpoch),
      ),
    );
    if (entry.type === "0") {
      blocks.push(content);
      const remainder = content.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function parseCanonicalArchive(
  archive,
  { manifestBytes, manifest, sourceDateEpoch },
) {
  invariant(Buffer.isBuffer(archive), "archive must be bytes");
  invariant(archive.length >= 18, "gzip archive is truncated");
  invariant(
    archive
      .subarray(0, 10)
      .equals(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3])),
    "gzip header is not canonical timestamp-free stored DEFLATE",
  );
  const tar = gunzipSync(archive);
  invariant(
    canonicalGzip(tar).equals(archive),
    "gzip stream is not the single canonical stream",
  );
  invariant(
    tar.length % 512 === 0 && tar.length >= 1024,
    "ustar stream is not block aligned",
  );

  const expectedFiles = new Map([
    [
      MANIFEST_NAME,
      {
        bytes: manifestBytes.length,
        sha256: sha256(manifestBytes),
        content: manifestBytes,
      },
    ],
  ]);
  for (const sample of manifest.samples)
    for (const file of sample.files)
      expectedFiles.set(`${sample.id}/${file.path}`, file);
  const expected = [
    ...[...parentDirectories(expectedFiles.keys())].map((item) => ({
      path: item,
      type: "5",
    })),
    ...[...expectedFiles].map(([item, record]) => ({
      path: item,
      type: "0",
      record,
    })),
  ].sort((left, right) => compareUtf8(left.path, right.path));

  const actual = [];
  const contents = new Map();
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      invariant(
        offset + 1024 === tar.length &&
          tar.subarray(offset).every((byte) => byte === 0),
        "ustar has trailing or noncanonical end blocks",
      );
      offset = tar.length;
      break;
    }
    invariant(
      header.subarray(257, 263).equals(Buffer.from("ustar\0")) &&
        header.subarray(263, 265).equals(Buffer.from("00")),
      "archive member is not canonical ustar",
    );
    const checksumField = header.subarray(148, 156);
    const recordedChecksum = Number.parseInt(
      checksumField.subarray(0, 6).toString("ascii"),
      8,
    );
    invariant(
      Number.isSafeInteger(recordedChecksum) &&
        checksumField[6] === 0 &&
        checksumField[7] === 0x20,
      "ustar checksum encoding drifted",
    );
    const checksumCopy = Buffer.from(header);
    checksumCopy.fill(0x20, 148, 156);
    invariant(
      checksumCopy.reduce((sum, byte) => sum + byte, 0) === recordedChecksum,
      "ustar checksum mismatch",
    );
    const name = cString(header.subarray(0, 100), "ustar name");
    const prefix = cString(header.subarray(345, 500), "ustar prefix");
    const type = String.fromCharCode(header[156]);
    invariant(
      type === "0" || type === "5",
      "archive contains a link, device, FIFO, PAX, GNU, or other unsupported member",
    );
    let archivePath = prefix ? `${prefix}/${name}` : name;
    if (type === "5") archivePath += "/";
    safePath(archivePath, "archive member path");
    invariant(
      !seen.has(archivePath),
      `duplicate archive member: ${archivePath}`,
    );
    seen.add(archivePath);
    const mode = parseOctal(header.subarray(100, 108), "ustar mode");
    const uid = parseOctal(header.subarray(108, 116), "ustar uid");
    const gid = parseOctal(header.subarray(116, 124), "ustar gid");
    const size = parseOctal(header.subarray(124, 136), "ustar size");
    const mtime = parseOctal(header.subarray(136, 148), "ustar mtime");
    invariant(
      uid === 0 && gid === 0 && mtime === Number(sourceDateEpoch),
      `${archivePath}: ustar identity or mtime drifted`,
    );
    invariant(
      cString(header.subarray(157, 257), "ustar linkname") === "",
      `${archivePath}: archive link target is forbidden`,
    );
    invariant(
      cString(header.subarray(265, 297), "ustar uname") === "" &&
        cString(header.subarray(297, 329), "ustar gname") === "",
      `${archivePath}: owner names must be empty`,
    );
    invariant(
      parseOctal(header.subarray(329, 337), "ustar devmajor") === 0 &&
        parseOctal(header.subarray(337, 345), "ustar devminor") === 0,
      `${archivePath}: device metadata is forbidden`,
    );
    invariant(
      (type === "5" && mode === 0o755 && size === 0) ||
        (type === "0" && mode === 0o644),
      `${archivePath}: member mode/type/size drifted`,
    );
    offset += 512;
    const content = tar.subarray(offset, offset + size);
    invariant(content.length === size, `${archivePath}: member is truncated`);
    const padding = (512 - (size % 512)) % 512;
    invariant(
      tar
        .subarray(offset + size, offset + size + padding)
        .every((byte) => byte === 0),
      `${archivePath}: member padding is nonzero`,
    );
    actual.push({ path: archivePath, type });
    if (type === "0") {
      const record = expectedFiles.get(archivePath);
      invariant(
        record && record.bytes === size && record.sha256 === sha256(content),
        `${archivePath}: bytes or SHA-256 drifted from manifest`,
      );
      if (record.content)
        invariant(
          content.equals(record.content),
          `${archivePath}: manifest member bytes drifted`,
        );
      contents.set(archivePath, Buffer.from(content));
    }
    offset += size + padding;
  }
  invariant(offset === tar.length, "ustar stream has no exact end marker");
  invariant(
    JSON.stringify(actual) ===
      JSON.stringify(
        expected.map(({ path: item, type }) => ({ path: item, type })),
      ),
    "ustar member set, type, or order drifted",
  );
  invariant(
    reconstructCanonicalTar(expected, contents, sourceDateEpoch).equals(tar),
    "ustar bytes are not the single canonical representation",
  );
  return { fileCount: expectedFiles.size, memberCount: expected.length };
}

export function validateDeterministicReceipt(
  receipt,
  { sourceCommit, sourceDateEpoch, lockfileSha256 },
) {
  exactKeys(
    receipt,
    ["schema", "source", "build", "publication", "smoke"],
    "deterministic receipt",
  );
  invariant(
    receipt.schema === "honua.sdk.sample-bundle-attestation.v1",
    "deterministic receipt schema drifted",
  );
  exactKeys(
    receipt.source,
    ["repository", "commit", "ref", "sourceDateEpoch"],
    "deterministic source",
  );
  invariant(
    receipt.source.repository === "honua-io/honua-sdk-js" &&
      receipt.source.commit === sourceCommit &&
      receipt.source.ref === "refs/heads/trunk" &&
      receipt.source.sourceDateEpoch === Number(sourceDateEpoch),
    "deterministic source drifted",
  );
  exactKeys(
    receipt.build,
    ["node", "lockfileSha256", "workflow", "actions"],
    "deterministic build",
  );
  invariant(
    receipt.build.node === NODE_VERSION &&
      receipt.build.lockfileSha256 === lockfileSha256 &&
      receipt.build.workflow === WORKFLOW_PATH,
    "deterministic build identity drifted",
  );
  invariant(
    JSON.stringify(receipt.build.actions) === JSON.stringify(ACTIONS),
    "deterministic action identity drifted",
  );
  exactKeys(
    receipt.publication,
    ["tag", "fileCount", "memberCount", "assets"],
    "deterministic publication",
  );
  invariant(
    receipt.publication.tag === `sample-bundles-${sourceCommit}`,
    "deterministic tag drifted",
  );
  exactKeys(
    receipt.publication.assets,
    [MANIFEST_NAME, ARCHIVE_NAME],
    "deterministic assets",
  );
  for (const [name, asset] of Object.entries(receipt.publication.assets)) {
    exactKeys(asset, ["bytes", "sha256"], `${name} receipt asset`);
    integer(asset.bytes, 1, 10_000_000_000, `${name} receipt bytes`);
    invariant(SHA256.test(asset.sha256), `${name} receipt SHA-256 is invalid`);
  }
  exactKeys(
    receipt.smoke,
    ["rawSha256", "total", "passed", "failed", "results"],
    "deterministic smoke",
  );
  invariant(
    SHA256.test(receipt.smoke.rawSha256),
    "smoke receipt digest is invalid",
  );
  integer(receipt.smoke.total, 1, 100, "smoke total");
  integer(
    receipt.smoke.passed,
    receipt.smoke.total,
    receipt.smoke.total,
    "smoke passed",
  );
  integer(receipt.smoke.failed, 0, 0, "smoke failed");
  invariant(
    Array.isArray(receipt.smoke.results) &&
      receipt.smoke.results.length === receipt.smoke.total,
    "normalized smoke results drifted",
  );
  for (const result of receipt.smoke.results) {
    exactKeys(
      result,
      ["id", "passed", "requestCount", "network", "staticJourney", "liveProbe"],
      "normalized smoke result",
    );
    invariant(
      SAMPLE_ID.test(result.id) && result.passed === true,
      "normalized smoke result identity drifted",
    );
    integer(result.requestCount, 1, 10000, `${result.id} requestCount`);
    exactKeys(
      result.network,
      ["offOriginRequestCount", "clientErrorResponseCount"],
      `${result.id} network`,
    );
    invariant(
      result.network.offOriginRequestCount === 0 &&
        result.network.clientErrorResponseCount === 0,
      `${result.id} network failures drifted`,
    );
    exactKeys(
      result.staticJourney,
      ["policy", "status"],
      `${result.id} static journey`,
    );
    invariant(
      ["not-required", "coverage", "interaction"].includes(
        result.staticJourney.policy,
      ) && ["not-required", "passed"].includes(result.staticJourney.status),
      `${result.id} static journey enum drifted`,
    );
    invariant(
      (result.staticJourney.policy === "not-required" &&
        result.staticJourney.status === "not-required") ||
        (result.staticJourney.policy !== "not-required" &&
          result.staticJourney.status === "passed"),
      `${result.id} static journey policy/status pairing drifted`,
    );
    allowedKeys(
      result.liveProbe,
      ["policy", "status"],
      ["policy", "status", "origin", "httpStatus", "featureCount"],
      `${result.id} live probe`,
    );
    invariant(
      ["not-required", "geojson-feature-collection"].includes(
        result.liveProbe.policy,
      ) && ["not-required", "passed"].includes(result.liveProbe.status),
      `${result.id} live probe enum drifted`,
    );
    if (result.liveProbe.policy === "not-required") {
      exactKeys(
        result.liveProbe,
        ["policy", "status"],
        `${result.id} live probe`,
      );
      invariant(
        result.liveProbe.status === "not-required",
        `${result.id} live probe policy/status pairing drifted`,
      );
    } else {
      exactKeys(
        result.liveProbe,
        ["policy", "status", "origin", "httpStatus", "featureCount"],
        `${result.id} live probe`,
      );
      invariant(
        result.liveProbe.status === "passed" &&
          result.liveProbe.origin === "https://demo.pygeoapi.io",
        `${result.id} live probe identity drifted`,
      );
      integer(
        result.liveProbe.httpStatus,
        200,
        299,
        `${result.id} live HTTP status`,
      );
      integer(
        result.liveProbe.featureCount,
        1,
        1_000_000,
        `${result.id} live feature count`,
      );
    }
  }
}

export function validateRunReceipt(
  receipt,
  { sourceCommit, deterministicSha256 },
) {
  exactKeys(
    receipt,
    [
      "schema",
      "sourceCommit",
      "deterministicReceiptSha256",
      "workflow",
      "runner",
      "actions",
    ],
    "run receipt",
  );
  invariant(
    receipt.schema === "honua.sdk.sample-bundle-run-attestation.v1" &&
      receipt.sourceCommit === sourceCommit &&
      receipt.deterministicReceiptSha256 === deterministicSha256,
    "run receipt identity drifted",
  );
  exactKeys(
    receipt.workflow,
    ["repository", "path", "ref", "sha", "runId", "runAttempt"],
    "run workflow",
  );
  invariant(
    receipt.workflow.repository === "honua-io/honua-sdk-js" &&
      receipt.workflow.path === WORKFLOW_PATH &&
      receipt.workflow.ref === "refs/heads/trunk" &&
      receipt.workflow.sha === sourceCommit,
    "run workflow source drifted",
  );
  nonemptyString(receipt.workflow.runId, "workflow run id", 32);
  nonemptyString(receipt.workflow.runAttempt, "workflow run attempt", 16);
  exactKeys(
    receipt.runner,
    ["name", "environment", "os", "architecture", "image", "imageVersion"],
    "run runner",
  );
  Object.entries(receipt.runner).forEach(([key, value]) =>
    nonemptyString(value, `runner ${key}`, 256),
  );
  invariant(
    JSON.stringify(receipt.actions) === JSON.stringify(ACTIONS),
    "run action identity drifted",
  );
}

export async function createReceipts(options) {
  const [manifestBytes, archive, smokeBytes, lockfileBytes, packBytes] =
    await Promise.all([
      readFile(options.manifest),
      readFile(options.archive),
      readFile(options.smokeReceipt),
      readFile(options.lockfile),
      readFile(options.packMetadata),
    ]);
  const manifest = parseUniqueJson(manifestBytes, "sample bundle manifest");
  const smoke = parseUniqueJson(smokeBytes, "browser smoke receipt");
  const pack = parseUniqueJson(packBytes, "pack metadata");
  const lockfileSha256 = lockfileDependencyDigest(lockfileBytes);
  const { files } = validateManifest(manifest, {
    sourceCommit: options.sourceCommit,
    lockfileSha256,
  });
  const archiveSummary = parseCanonicalArchive(archive, {
    manifestBytes,
    manifest,
    sourceDateEpoch: options.sourceDateEpoch,
  });
  exactKeys(
    pack,
    [
      "schema",
      "sourceCommit",
      "sourceDateEpoch",
      "manifestSha256",
      "archiveSha256",
      "archiveBytes",
      "fileCount",
      "memberCount",
    ],
    "pack metadata",
  );
  invariant(
    pack.schema === "honua.sdk.sample-bundle-pack.v1" &&
      pack.sourceCommit === options.sourceCommit &&
      pack.sourceDateEpoch === Number(options.sourceDateEpoch),
    "pack metadata source drifted",
  );
  invariant(
    pack.manifestSha256 === sha256(manifestBytes) &&
      pack.archiveSha256 === sha256(archive) &&
      pack.archiveBytes === archive.length &&
      pack.fileCount === archiveSummary.fileCount &&
      pack.memberCount === archiveSummary.memberCount,
    "pack metadata bytes drifted",
  );
  invariant(
    archiveSummary.fileCount === files.size + 1,
    "archive file count drifted",
  );
  const normalizedSmoke = normalizeSmoke(
    smoke,
    manifest,
    options.sourceCommit,
    options.sourceDateEpoch,
  );

  const deterministic = {
    schema: "honua.sdk.sample-bundle-attestation.v1",
    source: {
      repository: "honua-io/honua-sdk-js",
      commit: options.sourceCommit,
      ref: "refs/heads/trunk",
      sourceDateEpoch: Number(options.sourceDateEpoch),
    },
    build: {
      node: NODE_VERSION,
      lockfileSha256,
      workflow: WORKFLOW_PATH,
      actions: ACTIONS,
    },
    publication: {
      tag: `sample-bundles-${options.sourceCommit}`,
      fileCount: archiveSummary.fileCount,
      memberCount: archiveSummary.memberCount,
      assets: {
        [MANIFEST_NAME]: {
          bytes: manifestBytes.length,
          sha256: sha256(manifestBytes),
        },
        [ARCHIVE_NAME]: { bytes: archive.length, sha256: sha256(archive) },
      },
    },
    smoke: { rawSha256: sha256(smokeBytes), ...normalizedSmoke },
  };
  validateDeterministicReceipt(deterministic, {
    sourceCommit: options.sourceCommit,
    sourceDateEpoch: options.sourceDateEpoch,
    lockfileSha256,
  });
  const deterministicBytes = Buffer.from(stableJson(deterministic));
  const run = {
    schema: "honua.sdk.sample-bundle-run-attestation.v1",
    sourceCommit: options.sourceCommit,
    deterministicReceiptSha256: sha256(deterministicBytes),
    workflow: {
      repository: options.repository,
      path: WORKFLOW_PATH,
      ref: options.workflowRef,
      sha: options.sourceCommit,
      runId: options.runId,
      runAttempt: options.runAttempt,
    },
    runner: {
      name: options.runnerName,
      environment: options.runnerEnvironment,
      os: options.runnerOs,
      architecture: options.runnerArch,
      image: options.runnerImage,
      imageVersion: options.runnerImageVersion,
    },
    actions: ACTIONS,
  };
  validateRunReceipt(run, {
    sourceCommit: options.sourceCommit,
    deterministicSha256: sha256(deterministicBytes),
  });
  await writeFile(options.deterministicReceipt, deterministicBytes, {
    flag: "wx",
    mode: 0o644,
  });
  await writeFile(options.runReceipt, stableJson(run), {
    flag: "wx",
    mode: 0o644,
  });
  return { deterministic, run };
}

export function classifyReleaseState({
  releaseExists,
  tagTarget,
  expectedSource,
  assets,
  expectedAssets,
}) {
  if (!releaseExists) return "create";
  if (tagTarget !== expectedSource) return "collision";
  const actualNames = Object.keys(assets).sort();
  const expectedNames = Object.keys(expectedAssets).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    return "partial";
  for (const name of expectedNames) {
    if (
      assets[name].sha256 !== expectedAssets[name].sha256 ||
      assets[name].bytes !== expectedAssets[name].bytes
    )
      return "divergent";
  }
  return "idempotent";
}

function exactObject(value, expected, label) {
  invariant(
    JSON.stringify(value) === JSON.stringify(expected),
    `${label} drifted`,
  );
}

function action(value, expected, label) {
  invariant(
    value === expected,
    `${label} action pin drifted; run npm run samples:bundles:attestation:sync-actions and commit the reviewed pin-record diff`,
  );
  const [repository, commit] = value.split("@");
  invariant(
    ACTION_COMMITS.get(repository) === commit && SHA.test(commit),
    `${label} action is not the expected commit object`,
  );
}

export function validateWorkflowDocument(workflow, { resolveAction } = {}) {
  exactKeys(
    workflow,
    ["name", "on", "permissions", "concurrency", "jobs"],
    "workflow",
  );
  invariant(
    workflow.name === "Publish content-addressed sample bundles",
    "workflow name drifted",
  );
  exactObject(workflow.on, { workflow_dispatch: null }, "workflow trigger");
  exactObject(workflow.permissions, {}, "global permissions");
  exactObject(
    workflow.concurrency,
    {
      group: "publish-content-addressed-sample-bundles",
      "cancel-in-progress": false,
    },
    "workflow concurrency",
  );
  exactKeys(
    workflow.jobs,
    ["build-and-smoke", "attest-and-publish"],
    "workflow jobs",
  );
  invariant(
    !JSON.stringify(workflow).includes("sample-bundles-latest"),
    "workflow may not read or modify the rolling release",
  );

  const build = workflow.jobs["build-and-smoke"];
  exactKeys(build, ["name", "runs-on", "permissions", "steps"], "build job");
  invariant(
    build.name === "Build, reproduce, and smoke" &&
      build["runs-on"] === "ubuntu-24.04",
    "build job identity drifted",
  );
  exactObject(build.permissions, { contents: "read" }, "build permissions");
  invariant(Array.isArray(build.steps), "build steps must be an array");
  const buildNames = [
    "Gate exact current trunk",
    "Checkout governance",
    "Checkout source A",
    "Checkout source B",
    "Set up Node",
    "Install source A",
    "Install source B",
    "Build, verify, pack, and smoke source A",
    "Build, verify, and pack source B",
    "Compare independent builds",
    "Create deterministic and run receipts",
    "Run governance tests and policy",
    "Stage transfer",
    "Upload governed publication",
  ];
  invariant(
    JSON.stringify(build.steps.map((step) => step.name)) ===
      JSON.stringify(buildNames),
    "build step order or set drifted",
  );
  for (const [index, checkoutName] of [
    [1, "Checkout governance"],
    [2, "Checkout source A"],
    [3, "Checkout source B"],
  ]) {
    const step = build.steps[index];
    action(step.uses, ACTIONS.checkout, checkoutName);
    exactObject(
      step.with,
      {
        ref: "${{ github.sha }}",
        path: ["governance", "source-a", "source-b"][index - 1],
        "persist-credentials": false,
      },
      `${checkoutName} inputs`,
    );
  }
  action(build.steps[4].uses, ACTIONS.setupNode, "setup-node");
  exactObject(
    build.steps[4].with,
    {
      "node-version": NODE_VERSION,
      cache: "npm",
      "cache-dependency-path": "source-a/package-lock.json",
    },
    "setup-node inputs",
  );
  action(build.steps[13].uses, ACTIONS.uploadArtifact, "upload-artifact");
  exactObject(
    build.steps[13].with,
    {
      name: "content-addressed-sample-bundles",
      path: "staged",
      "if-no-files-found": "error",
      "retention-days": 1,
      "compression-level": 0,
    },
    "upload-artifact inputs",
  );
  invariant(
    build.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))
      .length === 3,
    "workflow must have exactly three checkouts",
  );
  invariant(
    build.steps.every(
      (step) => !step.uses || Object.values(ACTIONS).includes(step.uses),
    ),
    "workflow contains an unapproved action",
  );
  invariant(
    build.steps[0].run.includes('GITHUB_REF" = "refs/heads/trunk') &&
      build.steps[0].run.includes("repos/$GITHUB_REPOSITORY/commits/trunk") &&
      build.steps[0].run.includes('CURRENT_SHA" = "$SOURCE_COMMIT'),
    "early trunk gate drifted",
  );
  const buildStepKeys = [
    ["name", "env", "run"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "working-directory", "run"],
    ["name", "working-directory", "run"],
    ["name", "working-directory", "env", "run"],
    ["name", "working-directory", "env", "run"],
    ["name", "run"],
    ["name", "env", "run"],
    ["name", "working-directory", "env", "run"],
    ["name", "run"],
    ["name", "uses", "with"],
  ];
  build.steps.forEach((step, index) =>
    exactKeys(step, buildStepKeys[index], `build step ${index}`),
  );
  exactObject(
    build.steps[0].env,
    { GH_TOKEN: "${{ github.token }}", SOURCE_COMMIT: "${{ github.sha }}" },
    "early gate environment",
  );
  exactObject(
    build.steps[7].env,
    { SOURCE_COMMIT: "${{ github.sha }}" },
    "source A environment",
  );
  exactObject(
    build.steps[8].env,
    { SOURCE_COMMIT: "${{ github.sha }}" },
    "source B environment",
  );
  exactObject(
    build.steps[10].env,
    { SOURCE_COMMIT: "${{ github.sha }}" },
    "receipt environment",
  );
  exactObject(
    build.steps[11].env,
    { GITHUB_TOKEN: "${{ github.token }}" },
    "policy environment",
  );

  const privileged = workflow.jobs["attest-and-publish"];
  exactKeys(
    privileged,
    ["name", "needs", "if", "runs-on", "permissions", "steps"],
    "privileged job",
  );
  invariant(
    privileged.name === "Attest and publish immutable release" &&
      privileged.needs === "build-and-smoke" &&
      privileged["runs-on"] === "ubuntu-24.04",
    "privileged job identity drifted",
  );
  invariant(
    privileged.if === "github.event_name == 'workflow_dispatch'",
    "privileged job condition drifted",
  );
  exactObject(
    privileged.permissions,
    {
      actions: "read",
      attestations: "write",
      contents: "write",
      "id-token": "write",
    },
    "privileged permissions",
  );
  const privilegedNames = [
    "Download governed publication",
    "Validate all bytes before tokens",
    "Gate current trunk and immutable releases",
    `Attest ${MANIFEST_NAME}`,
    `Attest ${ARCHIVE_NAME}`,
    `Attest ${DETERMINISTIC_NAME}`,
    `Attest ${RUN_NAME}`,
    "Create or accept exact immutable release",
    "Redownload, compare, and verify attestations",
  ];
  invariant(
    JSON.stringify(privileged.steps.map((step) => step.name)) ===
      JSON.stringify(privilegedNames),
    "privileged step order or set drifted",
  );
  action(
    privileged.steps[0].uses,
    ACTIONS.downloadArtifact,
    "download-artifact",
  );
  exactObject(
    privileged.steps[0].with,
    { name: "content-addressed-sample-bundles", path: "staged" },
    "download-artifact inputs",
  );
  for (let index = 3; index <= 6; index += 1)
    action(
      privileged.steps[index].uses,
      ACTIONS.attestBuildProvenance,
      privileged.steps[index].name,
    );
  invariant(
    privileged.steps.every(
      (step) => !step.uses || Object.values(ACTIONS).includes(step.uses),
    ),
    "privileged job contains an unapproved action",
  );
  invariant(
    !privileged.steps.some((step) =>
      step.uses?.startsWith("actions/checkout@"),
    ),
    "privileged job checks out repository source",
  );
  for (const step of privileged.steps) {
    invariant(
      !Object.keys(step.env ?? {}).some(
        (key) => key === "GITHUB_ENV" || key === "GITHUB_PATH",
      ),
      "privileged job declares an environment/path transfer key",
    );
    if (!step.run) continue;
    for (const command of step.run.split("\n").map((line) => line.trim())) {
      invariant(
        !/^(?:node|npm|npx)(?:\s|$)/u.test(command),
        "privileged job executes Node or npm",
      );
      invariant(
        !/(?:^|\s)(?:\.\/)?(?:scripts|src|test)\//u.test(command),
        "privileged job executes repository/build-controlled code",
      );
      invariant(
        !/>>?\s*["']?\$GITHUB_(?:ENV|PATH)\b/u.test(command) &&
          !/::(?:add-path|set-env)\b/u.test(command),
        "privileged job transfers environment or PATH state",
      );
    }
  }
  const privilegedStepKeys = [
    ["name", "uses", "with"],
    ["name", "env", "run"],
    ["name", "env", "run"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "uses", "with"],
    ["name", "env", "run"],
    ["name", "env", "run"],
  ];
  privileged.steps.forEach((step, index) =>
    exactKeys(step, privilegedStepKeys[index], `privileged step ${index}`),
  );
  exactObject(
    privileged.steps[1].env,
    {
      SOURCE_COMMIT: "${{ github.sha }}",
      EXPECTED_LOCKFILE_SHA256,
    },
    "byte validation environment",
  );
  for (const index of [2, 7, 8])
    exactObject(
      privileged.steps[index].env,
      { GH_TOKEN: "${{ github.token }}", SOURCE_COMMIT: "${{ github.sha }}" },
      `privileged environment ${index}`,
    );
  const attestationSubjects = [
    MANIFEST_NAME,
    ARCHIVE_NAME,
    DETERMINISTIC_NAME,
    RUN_NAME,
  ];
  for (let index = 3; index <= 6; index += 1)
    exactObject(
      privileged.steps[index].with,
      { "subject-path": `staged/${attestationSubjects[index - 3]}` },
      `attestation input ${index}`,
    );
  invariant(
    privileged.steps[1].run.includes("zlib.decompressobj(31)") &&
      privileged.steps[1].run.includes('kind in ("0", "5")') &&
      !Object.hasOwn(privileged.steps[1].env, "GH_TOKEN"),
    "pre-token validator is not independent or token-free",
  );
  invariant(
    privileged.steps[2].run.includes("immutable-releases") &&
      privileged.steps[2].run.includes("enforced_by_owner") &&
      privileged.steps[2].run.includes(
        "repos/$GITHUB_REPOSITORY/commits/trunk",
      ),
    "privileged owner/trunk preflight drifted",
  );
  const releaseRun = privileged.steps[7].run;
  const lateRef = releaseRun.lastIndexOf(
    'test "$GITHUB_REF" = "refs/heads/trunk"',
  );
  const lateApi = releaseRun.lastIndexOf(
    "repos/$GITHUB_REPOSITORY/commits/trunk",
  );
  const create = releaseRun.indexOf('"$GH" release create');
  invariant(
    lateRef >= 0 && lateApi > lateRef && create > lateApi,
    "late trunk gate is missing or ordered after release creation",
  );
  invariant(
    !releaseRun.slice(lateApi, create).includes("sleep") &&
      !releaseRun.includes("--clobber") &&
      releaseRun.includes('--target "$SOURCE_COMMIT"') &&
      releaseRun.includes("--latest=false"),
    "release creation can race, overwrite, or target the wrong source",
  );

  const governedRunBodies = Object.fromEntries(
    Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      job.steps
        .filter((step) => typeof step.run === "string")
        .map((step) => [`${jobName}/${step.name}`, sha256(step.run)]),
    ),
  );
  exactKeys(
    governedRunBodies,
    Object.keys(RUN_BODY_SHA256),
    "governed workflow run bodies",
  );
  invariant(
    JSON.stringify(governedRunBodies) === JSON.stringify(RUN_BODY_SHA256),
    "governed workflow run body digest drifted",
  );

  if (resolveAction) {
    for (const value of Object.values(ACTIONS)) {
      const [repository, commit] = value.split("@");
      const resolved = resolveAction(repository, commit);
      invariant(
        resolved?.type === "commit" && resolved.sha === commit,
        `${repository}@${commit} did not resolve to the expected commit object`,
      );
      invariant(
        resolved.verified === true,
        `${repository} commit is not verified`,
      );
    }
  }
  return true;
}

async function resolveActionCommits() {
  const results = new Map();
  for (const [repository, commit] of ACTION_COMMITS) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/commits/${commit}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "honua-sdk-js-governance",
          ...(process.env.GITHUB_TOKEN
            ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
      },
    );
    invariant(
      response.ok,
      `could not resolve ${repository}@${commit}: ${response.status}`,
    );
    const payload = await response.json();
    results.set(repository, {
      type: payload.sha === commit ? "commit" : "other",
      sha: payload.sha,
      verified: payload.commit?.verification?.verified === true,
    });
  }
  return results;
}

// `yaml` is the only non-builtin dependency this module needs, and only the
// `policy` command needs it. The `receipt` command runs from the pristine
// `governance/` checkout, which is deliberately never `npm ci`-installed, so a
// static import would make every publication fail with ERR_MODULE_NOT_FOUND
// (honua-io/honua-sdk-js#1325). Loading it here keeps the receipt path
// resolvable with no `node_modules` at all, which is the stronger guarantee:
// nothing installed from the registry can influence the receipts.
export async function validateWorkflowFile(
  workflowPath,
  { resolveActions = false } = {},
) {
  const { parse: parseYaml } = await import("yaml");
  const workflow = parseYaml(await readFile(workflowPath, "utf8"));
  const resolved = resolveActions ? await resolveActionCommits() : null;
  return validateWorkflowDocument(workflow, {
    resolveAction: resolved
      ? (repository) => resolved.get(repository)
      : undefined,
  });
}

const ACTION_KEY_BY_REPOSITORY = Object.freeze({
  "actions/checkout": "checkout",
  "actions/setup-node": "setupNode",
  "actions/upload-artifact": "uploadArtifact",
  "actions/download-artifact": "downloadArtifact",
  "actions/attest-build-provenance": "attestBuildProvenance",
});

/** Derive the reviewable pin record from the workflow's already-visible `uses` lines. */
export function synchronizeActionPins(policySource, workflow) {
  const observed = new Map();
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string") continue;
      const repository = Object.keys(ACTION_KEY_BY_REPOSITORY).find((candidate) =>
        step.uses.startsWith(`${candidate}@`),
      );
      if (!repository) continue;
      const match = /^([^@]+)@([0-9a-f]{40})$/u.exec(step.uses);
      invariant(
        match?.[1] === repository,
        `${repository} must use exactly ${repository}@<full commit SHA>`,
      );
      const commit = match[2];
      const key = ACTION_KEY_BY_REPOSITORY[repository];
      invariant(SHA.test(commit), `${repository} must remain pinned to a full commit SHA`);
      const previous = observed.get(key);
      invariant(!previous || previous === step.uses, `${repository} uses more than one commit in the workflow`);
      observed.set(key, step.uses);
    }
  }
  exactKeys(Object.fromEntries(observed), Object.values(ACTION_KEY_BY_REPOSITORY), "workflow action pins");
  let next = policySource;
  for (const [key, value] of observed) {
    const pattern = new RegExp(`(${key}:\\s*(?:\\n\\s*)?)"[^"]+"`, "gu");
    invariant((next.match(pattern) ?? []).length === 1, `policy source has no unique ${key} action pin`);
    next = next.replace(pattern, `$1${JSON.stringify(value)}`);
  }
  return next;
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === "policy") {
    await validateWorkflowFile(path.resolve(required(values, "workflow")), {
      resolveActions: values.get("resolve-actions") === "true",
    });
    process.stdout.write("immutable sample bundle workflow policy: PASS\n");
    return;
  }
  if (command === "sync-actions") {
    const workflowPath = path.resolve(required(values, "workflow"));
    const policySourcePath = path.resolve(fileURLToPath(import.meta.url));
    const { parse: parseYaml } = await import("yaml");
    const workflow = parseYaml(await readFile(workflowPath, "utf8"));
    const source = await readFile(policySourcePath, "utf8");
    const synchronized = synchronizeActionPins(source, workflow);
    if (synchronized !== source) await writeFile(policySourcePath, synchronized);
    process.stdout.write(
      synchronized === source ? "immutable sample bundle action pins: already current\n" : "immutable sample bundle action pins: UPDATED; review and commit the diff\n",
    );
    return;
  }
  if (command === "receipt") {
    await createReceipts({
      manifest: path.resolve(required(values, "manifest")),
      archive: path.resolve(required(values, "archive")),
      packMetadata: path.resolve(required(values, "pack-metadata")),
      smokeReceipt: path.resolve(required(values, "smoke-receipt")),
      lockfile: path.resolve(required(values, "lockfile")),
      deterministicReceipt: path.resolve(
        required(values, "deterministic-receipt"),
      ),
      runReceipt: path.resolve(required(values, "run-receipt")),
      sourceCommit: required(values, "source-commit"),
      sourceDateEpoch: required(values, "source-date-epoch"),
      repository: required(values, "repository"),
      workflowRef: required(values, "workflow-ref"),
      runId: required(values, "run-id"),
      runAttempt: required(values, "run-attempt"),
      runnerName: required(values, "runner-name"),
      runnerEnvironment: required(values, "runner-environment"),
      runnerOs: required(values, "runner-os"),
      runnerArch: required(values, "runner-arch"),
      runnerImage: required(values, "runner-image"),
      runnerImageVersion: required(values, "runner-image-version"),
    });
    process.stdout.write("immutable sample bundle receipts: PASS\n");
    return;
  }
  throw new Error(`unknown command: ${command ?? "missing"}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
