import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

export async function executeCandidateFixture({ candidate, work, root }) {
  const prefix = `honua-sdk39-${randomBytes(6).toString("hex")}`;
  const postgres = `${prefix}-pg`;
  const server = `${prefix}-server`;
  const redis = `${prefix}-redis`;
  function docker(args, options = {}) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, ...options });
    // Command arguments may include the ephemeral fixture password; do not echo them.
    if (result.status !== 0) throw new Error(`candidate fixture docker ${args[0]} failed: ${result.stderr?.slice(-1_000)}`);
    return result.stdout.trim();
  }
  docker(["network", "create", prefix]);
  try {
    const password = randomBytes(24).toString("hex");
    docker(["run", "-d", "--name", postgres, "--network", prefix, "-e", "POSTGRES_DB=certification",
      "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGIS_GDAL_ENABLED_DRIVERS=ENABLE_ALL", "postgis/postgis:16-3.4"]);
    docker(["run", "-d", "--name", redis, "--network", prefix, "redis:7.4-alpine", "redis-server", "--appendonly", "no"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync("docker", ["exec", postgres, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
      if (result.status === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.ok(ready, "fixture PostgreSQL did not become ready");
    docker(["exec", "-i", postgres, "psql", "-U", "postgres", "-d", "certification", "-v", "ON_ERROR_STOP=1"],
      { input: await readFile(path.join(root, "test/integration/seed/places-roads-v1.sql"), "utf8") });
    const connection = `Server=${postgres};Port=5432;Database=certification;User Id=postgres;Password=${password};`;
    docker(["run", "-d", "--name", server, "--network", prefix, "-p", "127.0.0.1::8080",
      "-e", "ASPNETCORE_ENVIRONMENT=Production", "-e", "ASPNETCORE_URLS=http://+:8080",
      "-e", `HONUA_ADMIN_PASSWORD=Aa1!${password}`, "-e", `ConnectionStrings__DefaultConnection=${connection}`,
      "-e", `ConnectionStrings__honua=${connection}`, "-e", `ConnectionStrings__Redis=${redis}:6379`,
      "-e", `Security__ConnectionEncryption__MasterKey=${randomBytes(32).toString("base64")}`,
      "-e", `Security__ConnectionEncryption__Salt=${randomBytes(16).toString("base64")}`,
      "-e", "HostValidation__AllowedHosts__0=127.0.0.1", candidate.server.image]);
    const expectedImageId = docker(["image", "inspect", candidate.server.image, "--format", "{{.Id}}"]);
    assert.equal(docker(["inspect", server, "--format", "{{.Image}}"]), expectedImageId, "running candidate image mismatch");
    const baseUrl = `http://${docker(["port", server, "8080/tcp"])}`;
    ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = JSON.parse(docker(["inspect", server, "--format", "{{json .State}}"]));
      assert.ok(state.Running, `exact candidate exited before readiness: exit=${state.ExitCode}, oom=${state.OOMKilled}`);
      try {
        const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { ready = true; break; }
      } catch { /* bounded startup poll; never an operation pass */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.ok(ready, "exact candidate did not become ready within 90 polls");
    await copyFile(path.join(root, "scripts/fixtures/installed-features.mjs"), path.join(work, "installed-features.mjs"));
    const output = path.join(work, "observations.json");
    const result = spawnSync(process.execPath, [path.join(work, "installed-features.mjs"), output], {
      cwd: work, env: { PATH: process.env.PATH, HONUA_INSTALLED_FIXTURE_URL: baseUrl }, encoding: "utf8", timeout: 180_000,
    });
    assert.equal(result.status, 0, `installed fixture consumer failed: ${result.stderr?.slice(-1_000)}`);
    return { observations: JSON.parse(await readFile(output, "utf8")), serverRuntime: { imageId: expectedImageId,
      image: candidate.server.image, fixture: "places-roads-v1", transport: "loopback-http" } };
  } finally {
    for (const name of [server, redis, postgres]) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", prefix], { stdio: "ignore" });
  }
}
