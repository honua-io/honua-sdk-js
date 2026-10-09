#!/usr/bin/env node
// The `honua admin` local installer starts `ADMIN_LOCAL_SERVER_IMAGE` (config/admin-client.v1.json
// `serverImage`). The release decides which server image customers install: honua-release
// `customer-install-manifest.json` `server.image`. This check fails when the two drift apart.
//
// The release is read at the immutable honua-release commit pinned in
// config/admin-client.v1.json `releaseManifestPin` (raw.githubusercontent.com), or from a local copy
// named by HONUA_RELEASE_INSTALL_MANIFEST (offline runs; provenance is still the pinned ref).
// Spec: getting-started-channel-pins.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DIGEST_REF = /^(?<repository>[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+?)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@(?<digest>sha256:[0-9a-f]{64})$/;

/** Split a digest-pinned image reference; a tag next to a digest is informational (the runtime pulls the digest). */
export function parseDigestRef(reference, label) {
  const match = DIGEST_REF.exec(String(reference ?? ""));
  if (!match) {
    throw new Error(`${label} is not a digest-pinned image reference (repository[:tag]@sha256:<64 hex>): ${JSON.stringify(reference)}`);
  }
  return { repository: match.groups.repository, digest: match.groups.digest };
}

export function generatedServerImage(generatedText) {
  const match = /export const ADMIN_LOCAL_SERVER_IMAGE = ("[^"\n]*") as const;/.exec(generatedText);
  if (!match) throw new Error("src/control-plane/generated/admin-operations.ts does not export ADMIN_LOCAL_SERVER_IMAGE.");
  return JSON.parse(match[1]);
}

export function assertReleasePin(pin) {
  if (!pin || typeof pin !== "object") throw new Error("config/admin-client.v1.json is missing releaseManifestPin.");
  if (pin.repository !== "honua-io/honua-release") throw new Error("releaseManifestPin.repository must be honua-io/honua-release.");
  if (!/^[0-9a-f]{40}$/.test(pin.ref ?? "")) throw new Error("releaseManifestPin.ref must be an immutable 40-character commit SHA.");
  if (pin.path !== "customer-install-manifest.json") throw new Error("releaseManifestPin.path must be customer-install-manifest.json.");
}

/**
 * Compare the installer pin (config + generated constant) with the release manifest's server image.
 * Returns a one-line summary; throws with every mismatch named.
 */
export function checkServerImagePin({ source, generatedText, releaseManifest }) {
  assertReleasePin(source.releaseManifestPin);
  const where = `${source.releaseManifestPin.repository}@${source.releaseManifestPin.ref}:${source.releaseManifestPin.path}`;
  const releaseImage = releaseManifest?.server?.image;
  const release = parseDigestRef(releaseImage, `${where} server.image`);
  const problems = [];
  const candidates = [
    ["config/admin-client.v1.json serverImage", source.serverImage],
    ["src/control-plane/generated/admin-operations.ts ADMIN_LOCAL_SERVER_IMAGE", generatedServerImage(generatedText)],
  ];
  for (const [label, value] of candidates) {
    let pinned;
    try {
      pinned = parseDigestRef(value, label);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (pinned.repository !== release.repository || pinned.digest !== release.digest) {
      problems.push(`${label} is ${value}, but the release installs ${releaseImage} (${where} server.image).`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Installer server image pin does not match the release manifest:\n  - ${problems.join("\n  - ")}\n` +
        "Advance config/admin-client.v1.json serverImage (and releaseManifestPin.ref) to the release, then run " +
        "`npm run admin-client:generate`.",
    );
  }
  return `Installer server image matches ${where} server.image (${release.repository}@${release.digest}).`;
}

async function loadReleaseManifest(pin) {
  const local = process.env.HONUA_RELEASE_INSTALL_MANIFEST;
  if (local) return JSON.parse(await readFile(local, "utf8"));
  const url = `https://raw.githubusercontent.com/${pin.repository}/${pin.ref}/${pin.path}`;
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "honua-sdk-js-server-image-pin" } });
  if (!response.ok) throw new Error(`Unable to fetch the pinned release install manifest (${response.status}) from ${url}`);
  return response.json();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const source = JSON.parse(await readFile(path.join(root, "config", "admin-client.v1.json"), "utf8"));
    assertReleasePin(source.releaseManifestPin);
    const generatedText = await readFile(path.join(root, "src", "control-plane", "generated", "admin-operations.ts"), "utf8");
    const releaseManifest = await loadReleaseManifest(source.releaseManifestPin);
    process.stdout.write(`${checkServerImagePin({ source, generatedText, releaseManifest })}\n`);
  } catch (error) {
    process.stderr.write(`check-server-image-pin: ${error.message}\n`);
    process.exitCode = 1;
  }
}
