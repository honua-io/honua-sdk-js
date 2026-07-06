import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

const CLIENT_ID = "honua-oauth-demo";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:oauth-signin:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error("Failed to build the oauth-signin sample.");
  }
}

function serveStatic(res, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

/** base64url(SHA-256(verifier)) — the server side of PKCE S256. */
function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export async function startOAuthSignInFixtureServer({ build = true } = {}) {
  if (build) {
    buildDemoIfNeeded();
  }

  // Pending authorization codes → { codeChallenge, redirectUri }.
  const pendingCodes = new Map();
  // Issued refresh tokens (so refresh_token grants can be validated).
  const refreshTokens = new Set();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    // ── Mock IdP: authorization endpoint (auto-consent) ────────
    if (pathname === "/oauth/authorize") {
      const params = requestUrl.searchParams;
      const redirectUri = params.get("redirect_uri") ?? "/";
      const state = params.get("state") ?? "";
      const codeChallenge = params.get("code_challenge");
      const method = params.get("code_challenge_method");
      if (params.get("client_id") !== CLIENT_ID || !codeChallenge || method !== "S256") {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomUUID();
      pendingCodes.set(code, { codeChallenge, redirectUri });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }

    // ── Mock IdP: token endpoint (code exchange + refresh) ─────
    if (pathname === "/oauth/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const grantType = body.get("grant_type");

      if (grantType === "authorization_code") {
        const code = body.get("code") ?? "";
        const verifier = body.get("code_verifier") ?? "";
        const pending = pendingCodes.get(code);
        pendingCodes.delete(code);
        // Server-side PKCE verification.
        if (!pending || body.get("client_id") !== CLIENT_ID || pkceChallenge(verifier) !== pending.codeChallenge) {
          json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        const refreshToken = randomUUID();
        refreshTokens.add(refreshToken);
        json(res, 200, {
          access_token: `access-${randomUUID()}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
          scope: body.get("scope") ?? "openid profile honua.read",
        });
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = body.get("refresh_token") ?? "";
        if (!refreshTokens.has(refreshToken)) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
          return;
        }
        json(res, 200, {
          access_token: `access-${randomUUID()}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
        });
        return;
      }

      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    // ── Protected resource: requires a bearer token ────────────
    if (pathname === "/api/v1/whoami") {
      const authorization = req.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer access-")) {
        json(res, 401, { error: { code: 401, message: "Unauthorized" } });
        return;
      }
      json(res, 200, { user: "demo-user", scopes: ["openid", "profile", "honua.read"] });
      return;
    }

    // ── Static example assets (built dist/, SPA fallback) ──────
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const staticPath = path.join(distRoot, requestedPath);
    if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveStatic(res, staticPath);
      return;
    }
    const indexPath = path.join(distRoot, "index.html");
    if (!path.extname(pathname) && fs.existsSync(indexPath)) {
      serveStatic(res, indexPath);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the oauth-signin fixture server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startOAuthSignInFixtureServer();
  process.stdout.write(`oauthSignInUrl=${server.url}\n`);
}
