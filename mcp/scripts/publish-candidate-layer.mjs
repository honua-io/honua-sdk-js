#!/usr/bin/env node
// Publish the installer's own zero-to-map table on a freshly booted candidate,
// so the scheduled MCP certification has a real layer to round-trip against.
//
// `honua admin install local` creates `public.zero_to_map_parcels` but publishes
// nothing, and the certifier's `HONUA_MCP_SERVICE_ID=discover` mode then finds no
// layer and reports `round-trip-target` as blocked on every run (honua-sdk-js#2249).
// This is the step a user takes next: create a secure connection that resolves the
// installer's database password by reference (`env:HONUA_LOCAL_DB_PASSWORD`, which
// the generated compose allow-lists), validate the table, publish it, enable it.
// It uses only the public admin REST API; nothing is written to the database
// directly and no credential material is placed in a request body.
//
//   node mcp/scripts/publish-candidate-layer.mjs <base-url>   # key from HONUA_API_KEY
//
// Under GitHub Actions the published `service_id` and `layer_id` are written to
// $GITHUB_OUTPUT. The key is never printed.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CANDIDATE_TABLE = Object.freeze({ schema: "public", table: "zero_to_map_parcels" });
export const CANDIDATE_LAYER_NAME = "Parcels";
const ADMIN = "/api/v1/admin";

export async function publishCandidateLayer({ baseUrl, apiKey, fetch = globalThis.fetch }) {
  if (!apiKey) throw new Error("publish-candidate-layer: an admin key is required");
  const origin = new URL(baseUrl).origin;

  async function call(method, route, body) {
    const response = await fetch(`${origin}${ADMIN}${route}`, {
      method,
      headers: { "X-API-Key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = (await response.text()).split(apiKey).join("[redacted]").slice(0, 500);
      throw new Error(`${method} ${ADMIN}${route} returned ${response.status}: ${text}`);
    }
    const payload = await response.json();
    if (payload?.success === false || payload?.data === undefined) {
      throw new Error(`${method} ${ADMIN}${route} did not succeed: ${JSON.stringify(payload).slice(0, 500)}`);
    }
    return payload.data;
  }

  const connection = await call("POST", "/connections", {
    name: "zero-to-map-local",
    description: "Installer database, published for scheduled MCP certification",
    host: "postgres",
    port: 5432,
    databaseName: "honua",
    username: "honua",
    secretReference: "env:HONUA_LOCAL_DB_PASSWORD",
    secretType: "environment",
    sslMode: "Disable",
  });
  const connectionId = connection.connectionId;
  if (!connectionId) throw new Error("publish-candidate-layer: the candidate returned no connectionId");
  const id = encodeURIComponent(connectionId);

  const validation = await call("POST", `/connections/${id}/tables/validate`, { ...CANDIDATE_TABLE });
  if (validation.isValid !== true) {
    throw new Error(`publish-candidate-layer: ${CANDIDATE_TABLE.schema}.${CANDIDATE_TABLE.table} is not publishable (status ${validation.status ?? "unknown"})`);
  }

  const published = await call("POST", `/connections/${id}/layers`, {
    ...CANDIDATE_TABLE,
    layerName: CANDIDATE_LAYER_NAME,
    geometryColumn: validation.geometryColumn,
    primaryKey: validation.primaryKey,
  });
  if (!Number.isInteger(published.layerId)) throw new Error("publish-candidate-layer: the candidate returned no layerId");

  // The candidate leaves a newly published layer disabled whatever the request
  // says; a disabled layer is not listed, so enable it explicitly and require
  // the candidate to confirm it.
  const enabled = await call("PUT", `/connections/${id}/layers/${published.layerId}/enabled`, { enabled: true });
  if (enabled.enabled !== true) {
    throw new Error(`publish-candidate-layer: the candidate did not enable layer ${published.layerId}`);
  }

  return { connectionId, layerId: published.layerId, layerName: published.layerName, serviceName: published.serviceName };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const baseUrl = process.argv[2];
    if (!baseUrl) throw new Error("usage: publish-candidate-layer.mjs <base-url> (admin key in HONUA_API_KEY)");
    const result = await publishCandidateLayer({ baseUrl, apiKey: process.env.HONUA_API_KEY });
    console.log(`Published ${CANDIDATE_TABLE.schema}.${CANDIDATE_TABLE.table} as ${result.serviceName}/${result.layerId} (${result.layerName})`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `service_name=${result.serviceName}\nlayer_id=${result.layerId}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
