import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const immutable = /^[a-f0-9]{40}$/;

export async function selectInstalledCandidate({ repositoryRoot = root, eventName, mode,
  reviewedReleaseSha = "", candidateRef = "" } = {}) {
  assert.ok(["schedule", "workflow_dispatch"].includes(eventName), "unsupported candidate selection event");
  const selectedMode = eventName === "schedule" ? "current-release" : (mode || "current-release");
  if (selectedMode === "legacy-regression") {
    assert.equal(reviewedReleaseSha + candidateRef, "", "legacy regression cannot accept snapshot refs");
    return { mode: selectedMode, source: "explicit-legacy-dispatch" };
  }
  if (selectedMode === "release-snapshot") {
    assert.match(reviewedReleaseSha, immutable, "reviewed_release_sha must be an immutable release commit");
    assert.match(candidateRef, immutable, "candidate_ref must be an immutable nightly snapshot commit");
    return { mode: selectedMode, source: "explicit-snapshot-dispatch", reviewedReleaseSha, candidateRef };
  }
  assert.equal(selectedMode, "current-release", "unknown candidate selection mode");
  assert.equal(reviewedReleaseSha + candidateRef, "", "current release selection cannot override committed refs");
  let bytes;
  try {
    bytes = await readFile(path.join(repositoryRoot, "config/installed-candidate-selection.v1.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Current installed certification is blocked: no approved immutable release snapshot selection is committed. Publish and admit the candidate before selecting it; legacy fallback is forbidden.");
  }
  const selection = JSON.parse(bytes);
  assert.deepEqual(Object.keys(selection).sort(), ["candidateRef", "reviewedReleaseSha", "schema"],
    "current installed selection must contain only its schema and two immutable refs");
  assert.equal(selection.schema, "honua.installed-candidate-selection/v1", "unsupported installed selection schema");
  assert.match(selection.reviewedReleaseSha, immutable, "current reviewedReleaseSha must be an immutable release commit");
  assert.match(selection.candidateRef, immutable, "current candidateRef must be an immutable nightly snapshot commit");
  return { mode: "release-snapshot", source: "committed-current-selection",
    reviewedReleaseSha: selection.reviewedReleaseSha, candidateRef: selection.candidateRef,
    selectionSha256: createHash("sha256").update(bytes).digest("hex") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const selection = await selectInstalledCandidate({ eventName: process.env.GITHUB_EVENT_NAME,
    mode: process.env.CANDIDATE_MODE, reviewedReleaseSha: process.env.REVIEWED_RELEASE_SHA,
    candidateRef: process.env.CANDIDATE_REF });
  assert.ok(process.env.GITHUB_OUTPUT && process.env.GITHUB_ENV, "selection requires GitHub output destinations");
  await appendFile(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\nreviewed_release_sha=${selection.reviewedReleaseSha ?? ""}\ncandidate_ref=${selection.candidateRef ?? ""}\n`);
  await appendFile(process.env.GITHUB_ENV, `HONUA_INSTALLED_CANDIDATE_MODE=${selection.mode}\n`);
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(path.join(root, "test-results/installed-candidate-selection.json"), `${JSON.stringify(selection, null, 2)}\n`);
}
