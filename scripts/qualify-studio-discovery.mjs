import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { McpClient, StudioToolCatalog } from "../dist/src/studio-agent/index.js";

const manifest = await readFile(new URL("../../sdkjs-20260913-platform-manifest.yaml", import.meta.url), "utf8");
const serverSection = manifest.split("  honua-server:\n")[1]?.split(/\n  [a-z][\w-]+:/)[0];
assert.ok(serverSection, "manifest server section missing");
const digest = serverSection.match(/^    digest: "(sha256:[a-f0-9]{64})"/m)?.[1];
assert.ok(digest, "manifest image digest missing");
const image = `ghcr.io/honua-io/honua-server@${digest}`;
const prefix = `sdk1397-${randomBytes(6).toString("hex")}`;
const pg = `${prefix}-pg`, redis = `${prefix}-redis`, server = `${prefix}-server`;
const password = `Aa1!${randomBytes(24).toString("hex")}`;
const key = randomBytes(32).toString("base64"), salt = randomBytes(16).toString("base64");
const redact = (value) => [password, key, salt].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
function docker(command, args = [], options = {}) {
  const result = spawnSync("docker", [command, ...args], { encoding: "utf8", timeout: 120_000, windowsHide: true, ...options });
  assert.equal(result.status, 0, redact(`docker ${command}: ${result.stderr}`));
  return result.stdout.trim();
}
const receipt = { schema: "honua.studio-discovery-diagnostic/v1", generatedAt: new Date().toISOString(),
  scope: "real manifest-pinned server; source-built SDK diagnostic, not installed-client or model certification",
  manifestSha256: createHash("sha256").update(manifest).digest("hex"), image, checks: [] };
try {
  docker("network", ["create", prefix]);
  docker("run", ["-d", "--name", pg, "--network", prefix, "-e", "POSTGRES_DB=studio", "-e", `POSTGRES_PASSWORD=${password}`, "postgis/postgis:18-3.6"]);
  docker("run", ["-d", "--name", redis, "--network", prefix, "redis:7.2-alpine"]);
  let databaseReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync("docker", ["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { stdio: "ignore", timeout: 5_000, windowsHide: true });
    if (probe.status === 0) { databaseReady = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.ok(databaseReady, "PostgreSQL not ready in 60 seconds");
  const connection = `Host=${pg};Database=studio;Username=postgres;Password=${password}`;
  docker("run", ["-d", "--name", server, "--network", prefix, "-p", "127.0.0.1::8080",
    "-e", "ASPNETCORE_ENVIRONMENT=Production", "-e", "ASPNETCORE_URLS=http://+:8080",
    "-e", `HONUA_ADMIN_PASSWORD=${password}`, "-e", `ConnectionStrings__DefaultConnection=${connection}`,
    "-e", `ConnectionStrings__honua=${connection}`, "-e", `ConnectionStrings__Redis=${redis}:6379`,
    "-e", `Security__ConnectionEncryption__MasterKey=${key}`, "-e", `Security__ConnectionEncryption__Salt=${salt}`,
    "-e", "HostValidation__AllowedHosts__0=127.0.0.1", "-e", "Mcp__ServerInitiatedStreamEnabled=true", image]);
  receipt.imageId = docker("inspect", [server, "--format", "{{.Image}}"]);
  assert.equal(receipt.imageId, docker("image", ["inspect", image, "--format", "{{.Id}}"]));
  const baseUrl = `http://${docker("port", [server, "8080/tcp"])}`;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = JSON.parse(docker("inspect", [server, "--format", "{{json .State}}"]));
    assert.ok(state.Running, `candidate exited: ${state.ExitCode}`);
    try { if ((await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(2_000) })).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.ok(ready, "candidate not ready in 90 seconds");
  receipt.checks.push({ id: "candidate-readiness", verdict: "pass" });
  const client = new McpClient({ baseUrl, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, "X-API-Key": password } }) });
  const listing = await client.listAllTools({ signal: AbortSignal.timeout(30_000) });
  const catalog = StudioToolCatalog.fromDescriptors(listing.tools);
  receipt.discovery = { pages: listing.pages, descriptors: listing.tools, routed: catalog.toolDefinitions() };
  assert.ok(catalog.toolDefinitions().length > 0, "candidate must classify Studio composition tools");
  for (const tool of catalog.toolDefinitions()) {
    const original = listing.tools.find((descriptor) => descriptor.name === tool.name);
    assert.equal(original._meta?.["honua.studio"]?.family, "honua.studio.composition");
    assert.deepEqual(tool.annotations, original.annotations);
    assert.deepEqual(tool.outputSchema, original.outputSchema);
  }
  receipt.checks.push({ id: "live-classified-discovery-and-proxy-projection", verdict: "pass" });
  receipt.status = "partial";
} catch (error) {
  receipt.status = "failed";
  receipt.diagnostic = redact(error.stack);
  const logs = spawnSync("docker", ["logs", server], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  receipt.serverLogs = redact(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`).slice(-12_000);
  process.exitCode = 1;
} finally {
  for (const container of [server, redis, pg]) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 30_000, windowsHide: true });
  spawnSync("docker", ["network", "rm", prefix], { stdio: "ignore", timeout: 30_000, windowsHide: true });
  await writeFile(new URL("../test-results/studio-discovery-candidate.windows.json", import.meta.url), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks, diagnostic: receipt.diagnostic }, null, 2));
}
