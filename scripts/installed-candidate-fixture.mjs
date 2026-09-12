import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

export async function executeCandidateFixture({ candidate, work, root, spawn = spawnSync }) {
  const prefix = `honua-sdk39-${randomBytes(6).toString("hex")}`;
  const postgres = `${prefix}-pg`;
  const server = `${prefix}-server`;
  const redis = `${prefix}-redis`;
  const password = randomBytes(24).toString("hex");
  const masterKey = randomBytes(32).toString("base64");
  const salt = randomBytes(16).toString("base64");
  // Every diagnostic this fixture emits reaches a published receipt: certify() writes
  // error.message into install.diagnostic and that receipt is uploaded by CI. Strip the
  // ephemeral fixture secrets from all of them, not just from the container logs.
  const redact = (text) => [password, masterKey, salt].reduce((carried, secret) => carried.replaceAll(secret, "[redacted]"), String(text ?? ""));
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
    docker("run", ["-d", "--name", server, "--network", prefix, "-p", "127.0.0.1::8080",
      "-e", "ASPNETCORE_ENVIRONMENT=Production", "-e", "ASPNETCORE_URLS=http://+:8080",
      "-e", `HONUA_ADMIN_PASSWORD=Aa1!${password}`, "-e", `ConnectionStrings__DefaultConnection=${connection}`,
      "-e", `ConnectionStrings__honua=${connection}`, "-e", `ConnectionStrings__Redis=${redis}:6379`,
      "-e", `Security__ConnectionEncryption__MasterKey=${masterKey}`,
      "-e", `Security__ConnectionEncryption__Salt=${salt}`,
      "-e", "HostValidation__AllowedHosts__0=127.0.0.1", candidate.server.image]);
    const expectedImageId = docker("image", ["inspect", candidate.server.image, "--format", "{{.Id}}"]);
    assert.equal(docker("inspect", [server, "--format", "{{.Image}}"]), expectedImageId, "running candidate image mismatch");
    const baseUrl = `http://${docker("port", [server, "8080/tcp"])}`;
    ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = JSON.parse(docker("inspect", [server, "--format", "{{json .State}}"]));
      assert.ok(state.Running, `exact candidate exited before readiness: exit=${state.ExitCode}, oom=${state.OOMKilled}`);
      try {
        const response = await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { ready = true; break; }
      } catch { /* bounded startup poll; never an operation pass */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.ok(ready, "exact candidate did not become ready within 90 polls");
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
