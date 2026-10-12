import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { candidatePythonLock, pythonRequirements, verifyCandidatePythonRequirements } from "../../scripts/verify-candidate-python-requirements.mjs";

const canonical = "pyyaml==6.0.3\njsonschema==4.26.0\nreferencing==0.37.0\ncryptography==50.0.2\nattrs==26.1.0\ncffi==2.1.1\njsonschema-specifications==2025.9.1\npycparser==3.0\nrpds-py==2026.6.3\ntyping-extensions==4.16.0\n";
const locked = await readFile(candidatePythonLock, "utf8");

test("hash lock retains the complete reviewed upstream dependency denominator", () => {
  verifyCandidatePythonRequirements(canonical, locked);
  assert.equal(pythonRequirements(locked, true).length, 10);
});

test("future upstream additions, removals or version changes refuse without fallback", () => {
  for (const changed of [canonical + "extra==1.0\n", canonical.replace("attrs==26.1.0\n", ""),
    canonical.replace("pyyaml==6.0.3", "pyyaml==6.0.4")]) {
    assert.throws(() => verifyCandidatePythonRequirements(changed, locked), /differ from the reviewed/);
  }
});

test("missing hashes, floating versions, duplicate identities and unapproved options refuse", () => {
  const hash = `--hash=sha256:${"a".repeat(64)}`;
  for (const changed of ["pyyaml==6.0.3", "pyyaml>=6", `pyyaml==6.0.3 ${hash}\nPyYaml==6.0.3 ${hash}`,
    `pyyaml==6.0.3 ${hash} --trusted-host=other`, "", `pyyaml==6.0.3 --hash=sha256:invalid`]) {
    assert.throws(() => pythonRequirements(changed, true));
  }
});
