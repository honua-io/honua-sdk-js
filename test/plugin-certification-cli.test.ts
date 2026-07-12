import { describe, expect, it } from "vitest";
import { type PluginCertificationCliIo, runPluginCertificationCli } from "../src/plugin/cli.js";
import { REFERENCE_HOST, referenceProtocolManifest } from "./fixtures/plugins/reference/index.js";

interface Capture {
  readonly io: PluginCertificationCliIo;
  readonly out: string[];
  readonly err: string[];
  readonly written: Map<string, string>;
}

function harness(files: Readonly<Record<string, string>>): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  return {
    out,
    err,
    written,
    io: {
      readFile: async (path) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path]!;
      },
      writeFile: async (path, data) => {
        written.set(path, data);
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    },
  };
}

const MANIFEST_TEXT = JSON.stringify(referenceProtocolManifest);

describe("honua-plugin-certify CLI", () => {
  it("certifies a valid manifest and exits 0 with a machine-readable report", async () => {
    const cap = harness({ "manifest.json": MANIFEST_TEXT, "host.json": REFERENCE_HOST });
    const result = await runPluginCertificationCli(["--manifest", "manifest.json", "--host", "host.json"], cap.io);
    expect(result.exitCode).toBe(0);
    expect(result.report?.status).toBe("certified");
    const printed = JSON.parse(cap.out.join(""));
    expect(printed.status).toBe("certified");
    expect(printed.plugin.id).toBe(referenceProtocolManifest.id);
    expect(printed.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects an incompatible host and exits 1", async () => {
    const badHost = JSON.stringify({ ...JSON.parse(REFERENCE_HOST), environment: "browser" });
    const cap = harness({ "manifest.json": MANIFEST_TEXT, "host.json": badHost });
    const result = await runPluginCertificationCli(["-m", "manifest.json", "-H", "host.json"], cap.io);
    expect(result.exitCode).toBe(1);
    expect(result.report?.status).toBe("rejected");
    expect(result.report?.diagnostics.map((item) => item.code)).toContain("HOST_ENVIRONMENT_UNSUPPORTED");
  });

  it("writes the report to --out and keeps stdout empty", async () => {
    const cap = harness({ "manifest.json": MANIFEST_TEXT, "host.json": REFERENCE_HOST });
    const result = await runPluginCertificationCli(
      ["--manifest", "manifest.json", "--host", "host.json", "--out", "report.json", "--pretty"],
      cap.io,
    );
    expect(result.exitCode).toBe(0);
    expect(cap.out).toEqual([]);
    expect(cap.written.get("report.json")).toContain('"status": "certified"');
  });

  it("prints usage on --help and exits 0", async () => {
    const cap = harness({});
    const result = await runPluginCertificationCli(["--help"], cap.io);
    expect(result.exitCode).toBe(0);
    expect(cap.out.join("")).toContain("honua-plugin-certify");
  });

  it("reports a usage error and exits 2 when required inputs are missing", async () => {
    const cap = harness({ "host.json": REFERENCE_HOST });
    const result = await runPluginCertificationCli(["--host", "host.json"], cap.io);
    expect(result.exitCode).toBe(2);
    expect(cap.err.join("")).toContain("Missing required --manifest");
  });

  it("reports a usage error and exits 2 when a file cannot be read", async () => {
    const cap = harness({ "host.json": REFERENCE_HOST });
    const result = await runPluginCertificationCli(["--manifest", "missing.json", "--host", "host.json"], cap.io);
    expect(result.exitCode).toBe(2);
    expect(cap.err.join("")).toContain('Could not read --manifest file "missing.json"');
  });
});
