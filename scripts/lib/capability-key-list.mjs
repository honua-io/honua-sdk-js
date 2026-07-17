// Loads the canonical, dot-namespaced Honua capability key vocabulary
// published by honua-server (honua-io/honua-server#2893):
//   https://raw.githubusercontent.com/honua-io/honua-server/trunk/docs/gis/data/capability-keys.v1.json
//
// This repo NEVER copies that vocabulary -- it consumes it. Resolution order:
//   1. KEY_LIST_URL env var, if set to an http(s) URL -- fetched at run time.
//      Point this at the published capability-keys.v1.json (or a nightly
//      mirror) to validate against the live vocabulary.
//   2. config/capability-keys.fixture.json -- a pinned, loudly-marked,
//      point-in-time snapshot committed so validation stays hermetic and
//      network-independent by default (matches the pattern honua-samples and
//      honua-esri-assess already use for the same artifact).
//
// Consumed by scripts/sample-contract.mjs (capabilityKeys stamping, #635) and
// scripts/sdk-coverage.mjs (sdk-coverage.v1.json, #618).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_PATH = path.join(PROJECT_ROOT, "config", "capability-keys.fixture.json");

/**
 * @param {unknown} json
 * @returns {Set<string>}
 */
function toKeySet(json) {
  if (Array.isArray(json)) {
    return new Set(json.filter((value) => typeof value === "string"));
  }
  if (json && typeof json === "object") {
    const record = /** @type {Record<string, unknown>} */ (json);
    if (Array.isArray(record.keys)) {
      return new Set(record.keys.filter((value) => typeof value === "string"));
    }
    if (Array.isArray(record.capabilities)) {
      return new Set(
        record.capabilities
          .map((entry) => (entry && typeof entry === "object" ? /** @type {any} */ (entry).key : undefined))
          .filter((value) => typeof value === "string"),
      );
    }
  }
  throw new Error("Capability key list document has an unrecognized shape (expected an array, {keys:[]}, or {capabilities:[{key}]})");
}

/**
 * @returns {Promise<{ keys: Set<string>, source: string }>}
 */
export async function loadCapabilityKeyList() {
  const url = process.env.KEY_LIST_URL?.trim();

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `KEY_LIST_URL is set to "${url}" but is not an http(s) URL. Unset it to fall back to the pinned fixture, or point it at the published capability-keys.v1.json.`,
      );
    }
    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(`failed to fetch KEY_LIST_URL (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new Error(`KEY_LIST_URL (${url}) returned HTTP ${response.status}`);
    }
    const json = await response.json();
    return { keys: toKeySet(json), source: `KEY_LIST_URL (${url})` };
  }

  const json = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  return {
    keys: toKeySet(json),
    source: "config/capability-keys.fixture.json (pinned fixture -- see KEY_LIST_URL)",
  };
}
