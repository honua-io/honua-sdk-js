import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateFixturePackDirectory } from "../scenarios/fixture-validation.mjs";

const defaultFixturesRoot = path.dirname(fileURLToPath(import.meta.url));

export function verifyFixturePacks({
  fixturesRoot = defaultFixturesRoot,
  requestedPack,
  writeChecksums = false,
  acceptMetadata = false,
} = {}) {
  const resolvedFixturesRoot = path.resolve(fixturesRoot);
  const roots = [];
  for (const pack of fs.readdirSync(resolvedFixturesRoot, { withFileTypes: true })) {
    if (!pack.isDirectory() || (requestedPack && pack.name !== requestedPack)) continue;
    for (const revision of fs.readdirSync(path.join(resolvedFixturesRoot, pack.name), { withFileTypes: true })) {
      const root = path.join(resolvedFixturesRoot, pack.name, revision.name);
      if (revision.isDirectory() && fs.existsSync(path.join(root, "manifest.json"))) roots.push(root);
    }
  }
  roots.sort();
  if (roots.length === 0) throw new Error(`No fixture packs matched ${requestedPack ?? "the fixture root"}.`);

  // Validate every selected pack before preparing any writes so one malformed pack
  // cannot leave other packs partially refreshed.
  const inspections = roots.map((root) => {
    const validated = validateFixturePackDirectory(root, {
      allowChecksumChanges: true,
      allowMetadataChanges: true,
    });
    return {
      validated,
      report: {
        pack: `${validated.manifest.identity.id}@${validated.manifest.identity.version}`,
        manifest: path.relative(resolvedFixturesRoot, validated.manifestPath),
        checksumChanges: validated.checksumChanges,
        metadataChanged: validated.metadataChanged,
        metadataChanges: validated.metadataChanges,
        wroteChecksums: false,
        acceptedMetadata: false,
      },
    };
  });

  if (writeChecksums || acceptMetadata) {
    const pending = inspections
      .filter(
        ({ validated }) =>
          (writeChecksums && validated.checksumChanges.length > 0) || (acceptMetadata && validated.metadataChanged),
      )
      .map(({ validated, report }, index) => {
        const manifest = structuredClone(validated.manifest);
        if (writeChecksums && validated.checksumChanges.length > 0) {
          manifest.integrity.files = validated.actualChecksums;
          report.wroteChecksums = true;
        }
        if (acceptMetadata && validated.metadataChanged) {
          manifest.integrity.metadataFingerprint = validated.hashes.combined;
          manifest.integrity.metadataComponents = {
            license: validated.hashes.license,
            provenance: validated.hashes.provenance,
          };
          report.acceptedMetadata = true;
        }
        return {
          destination: validated.manifestPath,
          temporary: `${validated.manifestPath}.tmp-${process.pid}-${index}`,
          content: `${JSON.stringify(manifest, null, 2)}\n`,
        };
      });
    try {
      for (const update of pending) fs.writeFileSync(update.temporary, update.content, { flag: "wx" });
      for (const update of pending) fs.renameSync(update.temporary, update.destination);
    } finally {
      for (const update of pending) if (fs.existsSync(update.temporary)) fs.rmSync(update.temporary);
    }
  }

  const reports = inspections.map((inspection) => inspection.report);
  const failed = reports.some(
    (report) =>
      (report.checksumChanges.length > 0 && !report.wroteChecksums) ||
      (report.metadataChanged && !report.acceptedMetadata),
  );
  return {
    report: { fixturePackReportVersion: 1, reports },
    exitCode: failed ? 1 : 0,
  };
}

function parseArguments(arguments_) {
  const allowedFlags = new Set(["--write", "--accept-metadata"]);
  const positional = arguments_.filter((argument) => !argument.startsWith("--"));
  const unknownFlags = arguments_.filter((argument) => argument.startsWith("--") && !allowedFlags.has(argument));
  if (unknownFlags.length > 0 || positional.length > 1) {
    throw new Error("Usage: verify.mjs [--write] [--accept-metadata] [pack-id]");
  }
  if (positional[0] && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(positional[0])) {
    throw new Error("Fixture pack id is invalid.");
  }
  return {
    requestedPack: positional[0],
    writeChecksums: arguments_.includes("--write"),
    acceptMetadata: arguments_.includes("--accept-metadata"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyFixturePacks(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
