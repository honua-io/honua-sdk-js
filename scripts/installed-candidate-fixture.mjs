import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

export async function executeCandidateFixture({ candidate, work, root, spawn = spawnSync }) {
  const prefix = `honua-sdk39-${randomBytes(6).toString("hex")}`;
  const postgres = `${prefix}-pg`;
  const server = `${prefix}-server`;
  const redis = `${prefix}-redis`;
  const password = randomBytes(24).toString("hex");
  const masterKey = randomBytes(32).toString("base64");
  const salt = randomBytes(16).toString("base64");
  const keyRingPassword = randomBytes(16).toString("hex");
  // Every diagnostic this fixture emits reaches a published receipt: certify() writes
  // error.message into install.diagnostic and that receipt is uploaded by CI. Strip the
  // ephemeral fixture secrets from all of them, not just from the container logs.
  const redact = (text) => [password, masterKey, salt, keyRingPassword].reduce((carried, secret) => carried.replaceAll(secret, "[redacted]"), String(text ?? ""));
  // honua-server#4722 made the durable operation secret channel's key-ring certificate
  // mandatory whenever Redis backs it (every image after 3d82e847, including this fixture's
  // pinned candidate). Mint a throwaway per-run PKCS#12 so the candidate can boot at all,
  // mirroring scripts/realtime-live-candidate-deployment.sh (#1739).
  const keyRingKey = path.join(work, "keyring.key");
  const keyRingCert = path.join(work, "keyring.crt");
  const keyRingP12 = path.join(work, "keyring.p12");
  const openssl = (args) => {
    const result = spawnSync("openssl", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`candidate fixture openssl ${args[0]} failed: ${redact(result.stderr).slice(-1_000)}`);
  };
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=honua-sdk39-fixture", "-keyout", keyRingKey, "-out", keyRingCert]);
  openssl(["pkcs12", "-export", "-in", keyRingCert, "-inkey", keyRingKey, "-out", keyRingP12, "-passout", `pass:${keyRingPassword}`]);
  await rm(keyRingKey, { force: true });
  await rm(keyRingCert, { force: true });
  await chmod(keyRingP12, 0o644);
  // The subcommand is a separate parameter so the failure message never has to index into
  // the argument vector, which carries the secrets above and is never echoed.
  function docker(command, args, options = {}) {
    const result = spawn("docker", [command, ...args], { encoding: "utf8", timeout: 120_000, ...options });
    if (result.status !== 0) throw new Error(`candidate fixture docker ${command} failed: ${redact(result.stderr).slice(-1_000)}`);
    return result.stdout.trim();
  }
  docker("network", ["create", prefix]);
  try {
    docker("run", ["-d", "--name", postgres, "--network", prefix, "-e", "POSTGRES_DB=certification",
      "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGIS_GDAL_ENABLED_DRIVERS=ENABLE_ALL", "postgis/postgis:16-3.4"]);
    docker("run", ["-d", "--name", redis, "--network", prefix, "redis:7.4-alpine", "redis-server", "--appendonly", "no"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawn("docker", ["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { stdio: "ignore" });
      if (result.status === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.ok(ready, "fixture PostgreSQL did not become ready");
    docker("exec", ["-i", postgres, "psql", "-U", "postgres", "-d", "certification", "-v", "ON_ERROR_STOP=1"],
      { input: await readFile(path.join(root, "test/integration/seed/places-roads-v1.sql"), "utf8") });
    const connection = `Server=${postgres};Port=5432;Database=certification;User Id=postgres;Password=${password};`;
    const baseServerEnv = [
      "ASPNETCORE_ENVIRONMENT=Production", "ASPNETCORE_URLS=http://+:8080",
      `HONUA_ADMIN_PASSWORD=Aa1!${password}`, `ConnectionStrings__DefaultConnection=${connection}`,
      `ConnectionStrings__honua=${connection}`, `ConnectionStrings__Redis=${redis}:6379`,
      `Security__ConnectionEncryption__MasterKey=${masterKey}`,
      `Security__ConnectionEncryption__Salt=${salt}`,
      "Operations__SecretChannel__KeyRingCertificatePath=/app/keyring.p12",
      `Operations__SecretChannel__KeyRingCertificatePassword=${keyRingPassword}`,
      "HostValidation__AllowedHosts__0=127.0.0.1",
    ];
    // Mirrors MigrationSafetyClassifier.ComputeContractApprovalNonce: this fixture's seed
    // pre-journals the schema-floor migrations it adopts (see the seed's "Schema-floor guard
    // adoption" section), which makes the journal non-empty and therefore trips the unrelated
    // journal-scoped contract-apply gate (honua-server#2565/#2812) for older contract-annotated
    // migrations (import staging, etc.) this fixture has no use for. The candidate's rejection
    // names the exact pending set and the one-shot approval env var it needs; extract and supply
    // it rather than pre-computing a list that would drift as migrations are added.
    const contractApprovalNonce = (pendingScripts) =>
      createHash("sha256").update([...pendingScripts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"), "utf8").digest("hex").slice(0, 16);
    const startServer = (env) => docker("run", ["-d", "--name", server, "--network", prefix, "-p", "127.0.0.1::8080",
      "-v", `${keyRingP12}:/app/keyring.p12:ro`, ...env.flatMap((value) => ["-e", value]), candidate.server.image]);
    const expectedImageId = docker("image", ["inspect", candidate.server.image, "--format", "{{.Id}}"]);
    let serverEnv = baseServerEnv;
    startServer(serverEnv);
    assert.equal(docker("inspect", [server, "--format", "{{.Image}}"]), expectedImageId, "running candidate image mismatch");
    let baseUrl = `http://${docker("port", [server, "8080/tcp"])}`;
    const waitReady = async () => {
      for (let attempt = 0; attempt < 90; attempt++) {
        const state = JSON.parse(docker("inspect", [server, "--format", "{{json .State}}"]));
        if (!state.Running) return { ready: false, exitCode: state.ExitCode, oomKilled: state.OOMKilled };
        try {
          const response = await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(2_000) });
          if (response.ok) return { ready: true };
        } catch { /* bounded startup poll; never an operation pass */ }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return { ready: false, timedOut: true };
    };
    let outcome = await waitReady();
    if (!outcome.ready && !outcome.timedOut) {
      const startupLogs = spawn("docker", ["logs", server], { encoding: "utf8", timeout: 10_000 });
      const gateMatch = /Migration safety gate blocked pending contract-phase migration\(s\) on an existing database: ([\s\S]*?)\. These reviewed \(annotated\) contract migrations/.exec(
        `${startupLogs.stdout ?? ""}\n${startupLogs.stderr ?? ""}`);
      if (gateMatch) {
        const pendingScripts = gateMatch[1].split(",").map((name) => name.trim());
        serverEnv = [...baseServerEnv, `HONUA_APPROVE_CONTRACT_MIGRATIONS=${contractApprovalNonce(pendingScripts)}`];
        docker("rm", ["-f", server]);
        startServer(serverEnv);
        assert.equal(docker("inspect", [server, "--format", "{{.Image}}"]), expectedImageId, "running candidate image mismatch");
        baseUrl = `http://${docker("port", [server, "8080/tcp"])}`;
        outcome = await waitReady();
      }
    }
    assert.ok(!outcome.timedOut, "exact candidate did not become ready within 90 polls");
    assert.ok(outcome.ready, `exact candidate exited before readiness: exit=${outcome.exitCode}, oom=${outcome.oomKilled}`);
    await copyFile(path.join(root, "scripts/fixtures/installed-features.mjs"), path.join(work, "installed-features.mjs"));
    const output = path.join(work, "observations.json");
    const runConsumer = async () => {
      const result = spawn(process.execPath, [path.join(work, "installed-features.mjs"), output], {
        cwd: work, env: { PATH: process.env.PATH, HONUA_INSTALLED_FIXTURE_URL: baseUrl }, encoding: "utf8", timeout: 180_000,
      });
      assert.equal(result.status, 0, `installed fixture consumer failed: ${result.stderr?.slice(-1_000)}`);
      return JSON.parse(await readFile(output, "utf8"));
    };
    const observations = await runConsumer();
    let challenge;
    if (observations.every((row) => row.verdict === "pass")) {
      // Deliberately corrupt a value, after the baseline. A presence-only oracle
      // would miss this; the installed consumer must fail the query proof.
      docker("exec", ["-i", postgres, "psql", "-U", "postgres", "-d", "certification", "-v", "ON_ERROR_STOP=1"],
        { input: "UPDATE features SET attributes = jsonb_set(attributes, '{ratio}', '999'::jsonb) WHERE layer_id = 0 AND attributes->>'name' = 'alpha';" });
      const challenged = await runConsumer();
      assert.equal(challenged.find((row) => row.id.endsWith(":query"))?.verdict, "fail", "oracle failed to detect corrupted fixture value");
      challenge = { mutation: "alpha.ratio: 1.25 -> 999", detected: true, operation: "protocol-certification:featureserver:query" };
    }
    return { observations, serverRuntime: { imageId: expectedImageId,
      image: candidate.server.image, postgresImageId: docker("inspect", [postgres, "--format", "{{.Image}}"]),
      redisImageId: docker("inspect", [redis, "--format", "{{.Image}}"]), fixture: "places-roads-v1", transport: "loopback-http", challenge } };
  } catch (error) {
    const logs = spawn("docker", ["logs", server], { encoding: "utf8", timeout: 10_000 });
    const startupError = redact(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`).split("\n").filter((line) => /Unhandled exception|compatibility|PostGIS|PostgreSQL/.test(line)).slice(-8).join("\n");
    throw new Error(redact(`${error.message}${startupError ? `; ${startupError.slice(-4_000)}` : ""}`));
  } finally {
    for (const name of [server, redis, postgres]) spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    spawn("docker", ["network", "rm", prefix], { stdio: "ignore" });
  }
}
