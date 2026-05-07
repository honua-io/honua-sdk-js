import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:service-explorer:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_HONUA_SERVICE_EXPLORER_MODE: "fixture",
    },
  });

  if (result.status !== 0) {
    throw new Error("Failed to build the service explorer before starting the fixture server.");
  }
}

function serveBuffer(res, buffer, filePath) {
  const extension = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  if (!absolutePath.startsWith(distRoot)) return undefined;
  return absolutePath;
}

export async function startServiceExplorerFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const staticPath = resolveStaticPath(requestUrl.pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveBuffer(res, fs.readFileSync(staticPath), staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (requestUrl.pathname === "/" || !path.extname(requestUrl.pathname)) {
      serveBuffer(res, fs.readFileSync(indexPath), indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the service explorer fixture server.");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startServiceExplorerFixtureServer();
  process.stdout.write(`serviceExplorerMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
