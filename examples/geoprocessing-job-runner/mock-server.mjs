import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";
import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const fixture = JSON.parse(fs.readFileSync(path.join(exampleRoot, "fixture.json"), "utf8"));
const executionPath = `/ogc/processes/processes/${fixture.processId}/execution`;
const jobPath = `/ogc/processes/jobs/${fixture.jobId}`;
const resultsPath = `${jobPath}/results`;
const expectedBody = { inputs: fixture.inputs, response: "document" };
const MIME_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8" };

function buildDemoIfNeeded() {
  const result = runNpmScriptSync("demo:gp-runner:build", { cwd: projectRoot, stdio: "inherit", env: createFixtureBuildEnvironment() });
  if (result.status !== 0) throw new Error("Failed to build the Geoprocessing Job Runner sample.");
}
function serve(res, filePath) { res.writeHead(200, { "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(fs.readFileSync(filePath)); }
function sendJson(res, status, body, headers = {}) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); }
function statusDocument(status, progress, message) { return { processID: fixture.processId, type: "process", jobID: fixture.jobId, status, progress, message, links: [{ rel: "status", href: jobPath, type: "application/json" }, { rel: "results", href: resultsPath, type: "application/json" }] }; }
function resultArtifact() { return { id: "honolulu-hale-buffer-geometry", kind: "Inline", title: "Honolulu Hale 350 m buffer", href: `data:application/geo+json,${encodeURIComponent(JSON.stringify(fixture.resultFeature))}`, type: "application/geo+json" }; }
async function readJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }

export async function startGeoprocessingJobRunnerFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();
  const requests = [];
  let statusPolls = 0;
  let dismissed = false;
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      if (method === "POST" && requestUrl.pathname === executionPath) {
        const body = await readJson(req);
        requests.push({ method, path: requestUrl.pathname, body, prefer: req.headers.prefer ?? null });
        if (!isDeepStrictEqual(body, expectedBody)) { sendJson(res, 422, { type: "about:blank", title: "Invalid buffer inputs", status: 422, detail: "Invalid buffer inputs: pinned fixture inputs did not match geometry.buffer's admitted schema." }); return; }
        statusPolls = 0; dismissed = false;
        sendJson(res, 201, statusDocument("accepted", 5, "Buffer job accepted"), { location: jobPath }); return;
      }
      if (method === "GET" && requestUrl.pathname === jobPath) {
        requests.push({ method, path: requestUrl.pathname });
        if (dismissed) sendJson(res, 200, statusDocument("dismissed", 100, "Buffer job dismissed"));
        else if (++statusPolls === 1) sendJson(res, 200, statusDocument("running", 62, "Computing buffer geometry"));
        else sendJson(res, 200, statusDocument("successful", 100, "Buffer completed"));
        return;
      }
      if (method === "GET" && requestUrl.pathname === resultsPath) {
        requests.push({ method, path: requestUrl.pathname });
        if (dismissed) sendJson(res, 410, { type: "job-dismissed", title: "Job dismissed", status: 410, detail: "The fixture job was dismissed." });
        else if (statusPolls < 2) sendJson(res, 404, { type: "result-not-ready", title: "Result not ready", status: 404, detail: "The fixture job is not terminal." });
        else sendJson(res, 200, { output1: resultArtifact() });
        return;
      }
      if (method === "DELETE" && requestUrl.pathname === jobPath) { requests.push({ method, path: requestUrl.pathname }); dismissed = true; sendJson(res, 200, statusDocument("dismissed", 100, "Dismissed via OGC API")); return; }
      const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const staticPath = path.join(distRoot, requestedPath);
      if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) { serve(res, staticPath); return; }
      const indexPath = path.join(distRoot, "index.html");
      if (!path.extname(requestUrl.pathname) && fs.existsSync(indexPath)) { serve(res, indexPath); return; }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
    } catch (error) { sendJson(res, 500, { title: "Fixture server error", status: 500, detail: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind Geoprocessing Job Runner fixture server.");
  return { url: `http://127.0.0.1:${address.port}`, requests, fixture, async close() { await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { const server = await startGeoprocessingJobRunnerFixtureServer(); process.stdout.write(`geoprocessingJobRunnerUrl=${server.url}\n`); }
