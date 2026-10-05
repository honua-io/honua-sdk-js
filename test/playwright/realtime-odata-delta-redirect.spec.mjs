import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
test("browser fetch keeps custom headers on the collection origin", async ({ page }) => {
    const servers = [];
    async function listen(server) {
        servers.push(server);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected a loopback TCP address.");
        return `http://127.0.0.1:${address.port}`;
    }
    try {
        const bundle = await build({
            entryPoints: ["src/realtime/odata-delta.ts"],
            bundle: true,
            write: false,
            format: "esm",
            platform: "browser",
        });
        const received = [];
        const destination = await listen(createServer((request, response) => {
            received.push(request.headers);
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.setHeader("Access-Control-Allow-Headers", "*");
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ value: [], "@odata.deltaLink": "/odata/Incidents?$deltatoken=next" }));
        }));
        const originalHeaders = [];
        const origin = await listen(createServer((request, response) => {
            if (request.url === "/") {
                response.setHeader("Content-Type", "text/html");
                response.end("<!doctype html><title>Realtime transport</title>");
            }
            else if (request.url === "/transport.js") {
                response.setHeader("Content-Type", "text/javascript");
                response.end(bundle.outputFiles[0]?.text);
            }
            else {
                originalHeaders.push(request.headers);
                response.writeHead(307, { Location: `${destination}/odata/Incidents` });
                response.end("Collection redirect");
            }
        }));
        await page.goto(origin);
        const outcome = await page.evaluate(async (originUrl) => {
            const { createOdataDeltaTransport } = await import(`${originUrl}/transport.js`);
            return await new Promise((resolve) => {
                const transport = createOdataDeltaTransport({
                    url: `${originUrl}/odata/Incidents`,
                    pollIntervalMs: 60_000,
                    entityId: (entity) => entity.Id,
                    headers: () => ({ "X-API-Key": "test-key" }),
                });
                const handle = transport.subscribe({ sourceId: "incidents" }, {
                    next() {
                        handle.close();
                        resolve({ kind: "next" });
                    },
                    error(error) {
                        handle.close();
                        resolve({ kind: "error", code: error.code });
                    },
                    complete() { },
                });
            });
        }, origin);
        expect(originalHeaders[0]?.["x-api-key"]).toBe("test-key");
        expect(received.map((headers) => headers["x-api-key"])).not.toContain("test-key");
        expect(received).toHaveLength(0);
        expect(outcome).toEqual({ kind: "error", code: "invalid-event" });
    }
    finally {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    }
});
