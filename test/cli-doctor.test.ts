import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";
import { validateDiagnosticBundle } from "../src/diagnostics/index.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-doctor-test-"));
  roots.push(root);
  return root;
}

function capture(stream: NodeJS.WriteStream): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("honua doctor CLI", () => {
  it("emits a schema-valid local artifact and machine summary without raw secrets", async () => {
    const root = tempRoot();
    const exchange = path.join(root, "exchange.json");
    const output = path.join(root, "bundle.json");
    fs.writeFileSync(
      exchange,
      JSON.stringify({
        request: {
          method: "GET",
          url: "https://alice:password@example.test/api/items/123456?token=raw-query-token",
          headers: { authorization: "Bearer raw-auth", cookie: "raw-cookie", "x-request-id": "req-1" },
        },
        response: {
          status: 500,
          mediaType: "application/json",
          headers: { "content-type": "application/json", "set-cookie": "raw-set-cookie" },
          body: { message: "failed for person@example.test", apiKey: "raw-api-key" },
        },
      }),
    );
    const stdout = capture(process.stdout);
    const code = await run([
      "doctor",
      "--exchange",
      exchange,
      "--classification",
      "customer-data",
      "--redaction-acknowledged=true",
      "--share-with-support=false",
      "--output",
      output,
      "--json",
    ]);
    stdout.restore();
    expect(code).toBe(0);
    const summary = JSON.parse(stdout.text());
    expect(summary).toMatchObject({ format: "honua.doctor-result.v1", outcome: "emitted", uploaded: false });
    const bundleText = fs.readFileSync(output, "utf8");
    const bundle = JSON.parse(bundleText);
    expect(validateDiagnosticBundle(bundle).valid).toBe(true);
    expect(bundle.consent.shareWithSupport).toBe(false);
    for (const secret of [
      "raw-query-token",
      "raw-auth",
      "raw-cookie",
      "raw-set-cookie",
      "raw-api-key",
      "person@example.test",
    ]) {
      expect(bundleText).not.toContain(secret);
      expect(stdout.text()).not.toContain(secret);
    }
  });

  it("requires explicit consent and does not create output on validation failure", async () => {
    const root = tempRoot();
    const exchange = path.join(root, "exchange.json");
    const output = path.join(root, "bundle.json");
    fs.writeFileSync(exchange, JSON.stringify({ request: { method: "GET", url: "https://example.test/api" } }));
    const stderr = capture(process.stderr);
    const code = await run([
      "doctor",
      "--exchange",
      exchange,
      "--classification",
      "public",
      "--redaction-acknowledged=true",
      "--output",
      output,
    ]);
    stderr.restore();
    expect(code).toBe(2);
    expect(fs.existsSync(output)).toBe(false);
    expect(stderr.text()).not.toContain("example.test");
  });

  it("preserves configured base paths and structures probe failure without erasing the supplied exchange", async () => {
    const root = tempRoot();
    const exchange = path.join(root, "exchange.json");
    const output = path.join(root, "bundle.json");
    fs.writeFileSync(
      exchange,
      JSON.stringify({
        request: { method: "GET", url: "https://example.test/api/v1/services" },
        response: { status: 503 },
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("private upstream detail"));
    const code = await run(
      [
        "doctor",
        "--exchange",
        exchange,
        "--classification",
        "internal",
        "--redaction-acknowledged=true",
        "--share-with-support=false",
        "--output",
        output,
        "--json",
      ],
      { baseUrl: "https://example.test/honua" },
    );
    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.test/honua/api/v1/services?limit=1");
    const bundle = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(bundle.envelopes).toHaveLength(2);
    expect(bundle.envelopes[0].responseBody.preview).toContain("capability-probe-failed");
    expect(bundle.envelopes[1]).toMatchObject({ method: "GET", normalizedPath: "/api/v1/services", statusCode: 503 });
    expect(JSON.stringify(bundle)).not.toContain("private upstream detail");
  });

  it("replays a read into a new bundle and refuses mutation before network", async () => {
    const root = tempRoot();
    const source = path.join(root, "source.json");
    const output = path.join(root, "replay.json");
    fs.writeFileSync(
      source,
      JSON.stringify({
        schemaVersion: "1.0",
        contentClassification: "public",
        consent: { redactionAcknowledged: true, shareWithSupport: true },
        envelopes: [{ method: "GET", normalizedPath: "/api/v1/services?limit={value}" }],
      }),
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ services: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const code = await run(["doctor", "--replay", source, "--output", output, "--json"], {
      baseUrl: "https://example.test",
    });
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(validateDiagnosticBundle(JSON.parse(fs.readFileSync(output, "utf8"))).valid).toBe(true);

    const mutation = JSON.parse(fs.readFileSync(source, "utf8"));
    mutation.envelopes[0] = { method: "POST", normalizedPath: "/api/v1/applyEdits" };
    fs.writeFileSync(source, JSON.stringify(mutation));
    fetchMock.mockClear();
    const refused = await run(["doctor", "--replay", source, "--output", output], {
      baseUrl: "https://example.test",
    });
    expect(refused).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
