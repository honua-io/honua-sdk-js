import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HonuaGrpcError } from "../src/core/errors.js";
import { HonuaOptionalGrpcPeerError, explainOptionalGrpcLoadFailure } from "../src/core/optional-grpc-peer.js";

function missingPackage(name: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `Cannot find package '${name}' imported from /tmp/consumer/node_modules/@honua/sdk/core/client.js`,
  );
  error.code = "ERR_MODULE_NOT_FOUND";
  return error;
}

describe("optional gRPC peer diagnostics", () => {
  it("names the missing peer only for a gRPC module-resolution failure", () => {
    const error = explainOptionalGrpcLoadFailure(missingPackage("@connectrpc/connect"));
    expect(error).toBeInstanceOf(HonuaOptionalGrpcPeerError);
    expect(error).toMatchObject({ peer: "@connectrpc/connect" });
    expect((error as Error).message).toContain("@bufbuild/protobuf");
    expect((error as Error).message).toContain("@connectrpc/connect-web");
    expect((error as HonuaOptionalGrpcPeerError).cause).toBeInstanceOf(Error);
  });

  it("reads a nested package-not-found cause without relabeling a Connect failure", () => {
    const wrapped = new Error("gRPC adapter import failed", { cause: missingPackage("@bufbuild/protobuf") });
    const error = explainOptionalGrpcLoadFailure(wrapped);
    expect(error).toBeInstanceOf(HonuaOptionalGrpcPeerError);
    expect(error).toMatchObject({ peer: "@bufbuild/protobuf" });

    const connectFailure = new HonuaGrpcError(3, "invalid query mentions @connectrpc/connect");
    expect(explainOptionalGrpcLoadFailure(connectFailure)).toBe(connectFailure);

    const numericCode = Object.assign(new Error("connect failed for @connectrpc/connect-web"), { code: 14 });
    expect(explainOptionalGrpcLoadFailure(numericCode)).toBe(numericCode);

    const runtimeBug = new TypeError("Illegal invocation");
    expect(explainOptionalGrpcLoadFailure(runtimeBug)).toBe(runtimeBug);

    const missingOwnFile = new Error("Cannot find module '/tmp/sdk/core/grpc-adapter.js'");
    (missingOwnFile as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
    expect(explainOptionalGrpcLoadFailure(missingOwnFile)).toBe(missingOwnFile);
  });

  it("does not put literal optional-peer imports on the REST client", () => {
    const source = readFileSync(new URL("../src/core/client.ts", import.meta.url), "utf8");
    const runtimeSource = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\btypeof\s+import\s*\(/g, "typeImport(");
    expect(runtimeSource).not.toMatch(/\bimport\s*\(\s*["']@connectrpc\//);
    expect(runtimeSource).not.toMatch(/\bimport\s*\(\s*["']@bufbuild\//);
    expect(runtimeSource).not.toMatch(/\bimport\s*\(\s*["']\.\/grpc-adapter\.js["']/);
    expect(runtimeSource).not.toMatch(/\bimport\s*\(\s*["']\.\.\/gen\/geospatial\//);
    expect(source).toContain("importOptionalGrpcSpecifier");
    expect(source).toContain("import(/* @vite-ignore */ specifier)");
  });
});
