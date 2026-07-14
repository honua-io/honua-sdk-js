import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateFixturePackDirectory } from "../scenarios/fixture-validation.mjs";

const defaultFixturesRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(defaultFixturesRoot, "../..");
const biomeEntry = path.join(repositoryRoot, "node_modules/@biomejs/biome/bin/biome");

function serializeManifest(manifest) {
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    return execFileSync(
      process.execPath,
      [biomeEntry, "format", "--stdin-file-path", "samples/fixtures/generated-manifest.json"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        input: source,
        maxBuffer: 256 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (cause) {
    throw new Error("Fixture refresh requires the repository-pinned Biome formatter from npm ci.", { cause });
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertInspectionUnchanged(inspection) {
  const current = validateFixturePackDirectory(inspection.validated.root, {
    allowChecksumChanges: true,
    allowMetadataChanges: true,
  });
  const manifestContent = fs.readFileSync(current.manifestPath, "utf8");
  if (
    manifestContent !== inspection.manifestContent ||
    !sameJson(current.actualChecksums, inspection.validated.actualChecksums) ||
    !sameJson(current.checksumChanges, inspection.validated.checksumChanges) ||
    !sameJson(current.metadataChanges, inspection.validated.metadataChanges)
  ) {
    throw new Error(`Fixture pack ${inspection.report.pack} changed during refresh preflight.`);
  }
}

function validateAppliedUpdate(update, { writeChecksums, acceptMetadata }) {
  const current = validateFixturePackDirectory(update.inspection.validated.root, {
    allowChecksumChanges: !writeChecksums,
    allowMetadataChanges: !acceptMetadata,
  });
  if (fs.readFileSync(update.destination, "utf8") !== update.content) {
    throw new Error(`Fixture pack ${update.inspection.report.pack} manifest changed during refresh commit.`);
  }
  if (
    (writeChecksums && current.checksumChanges.length > 0) ||
    (!writeChecksums && !sameJson(current.checksumChanges, update.inspection.validated.checksumChanges)) ||
    (acceptMetadata && current.metadataChanged) ||
    (!acceptMetadata && !sameJson(current.metadataChanges, update.inspection.validated.metadataChanges))
  ) {
    throw new Error(`Fixture pack ${update.inspection.report.pack} failed post-write integrity validation.`);
  }
}

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
      manifestContent: fs.readFileSync(validated.manifestPath, "utf8"),
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
      .map((inspection, index) => {
        const { validated } = inspection;
        const manifest = structuredClone(validated.manifest);
        if (writeChecksums && validated.checksumChanges.length > 0) {
          manifest.integrity.files = validated.actualChecksums;
        }
        if (acceptMetadata && validated.metadataChanged) {
          manifest.integrity.metadataFingerprint = validated.hashes.combined;
          manifest.integrity.metadataComponents = {
            license: validated.hashes.license,
            provenance: validated.hashes.provenance,
          };
        }
        return {
          inspection,
          destination: validated.manifestPath,
          temporary: path.join(
            resolvedFixturesRoot,
            `.manifest-${validated.manifest.identity.id}-${process.pid}-${index}.tmp`,
          ),
          content: serializeManifest(manifest),
          originalContent: inspection.manifestContent,
        };
      });
    if (pending.length > 0) {
      const lockPath = path.join(resolvedFixturesRoot, ".fixture-refresh.lock");
      let lockDescriptor;
      const applied = [];
      try {
        lockDescriptor = fs.openSync(lockPath, "wx");
        for (const update of pending) assertInspectionUnchanged(update.inspection);
        for (const update of pending) fs.writeFileSync(update.temporary, update.content, { flag: "wx" });
        for (const update of pending) assertInspectionUnchanged(update.inspection);
        for (const update of pending) {
          fs.renameSync(update.temporary, update.destination);
          applied.push(update);
        }
        for (const update of pending) validateAppliedUpdate(update, { writeChecksums, acceptMetadata });
        for (const update of pending) {
          if (writeChecksums && update.inspection.validated.checksumChanges.length > 0) {
            update.inspection.report.wroteChecksums = true;
          }
          if (acceptMetadata && update.inspection.validated.metadataChanged) {
            update.inspection.report.acceptedMetadata = true;
          }
        }
      } catch (error) {
        const rollbackErrors = [];
        for (const update of applied.reverse()) {
          const rollback = `${update.temporary}.rollback`;
          try {
            fs.writeFileSync(rollback, update.originalContent, { flag: "wx" });
            fs.renameSync(rollback, update.destination);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          } finally {
            if (fs.existsSync(rollback)) fs.rmSync(rollback);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Fixture refresh failed and could not be fully rolled back.",
          );
        }
        throw error;
      } finally {
        for (const update of pending) if (fs.existsSync(update.temporary)) fs.rmSync(update.temporary);
        if (lockDescriptor !== undefined) {
          fs.closeSync(lockDescriptor);
          fs.rmSync(lockPath, { force: true });
        }
      }
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
