/**
 * Optional gRPC-Web peers are not part of a REST install. Resolution failures
 * for those packages become an actionable error only after `transport:
 * "grpc-web"` has actually loaded them. Connect/RPC failures are returned
 * unchanged so a real gRPC error is not relabeled as a missing install.
 */

const OPTIONAL_GRPC_PACKAGES = ["@connectrpc/connect-web", "@connectrpc/connect", "@bufbuild/protobuf"] as const;

const RESOLUTION_FAILURE =
  /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Failed to resolve module specifier|Failed to fetch dynamically imported module|Cannot find package|Cannot find module/;

export type OptionalGrpcPackage = (typeof OPTIONAL_GRPC_PACKAGES)[number];

export class HonuaOptionalGrpcPeerError extends Error {
  public readonly peer: OptionalGrpcPackage;

  public constructor(peer: OptionalGrpcPackage, cause: unknown) {
    const message = [
      `HonuaClient transport "grpc-web" could not load the optional peer "${peer}".`,
      "Install @bufbuild/protobuf, @connectrpc/connect, and @connectrpc/connect-web.",
      "REST, including createHonua, does not load them.",
    ].join(" ");
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "HonuaOptionalGrpcPeerError";
    this.peer = peer;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGenuineGrpcFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error instanceof Error && error.name === "HonuaGrpcError") return true;
  return typeof error.code === "number";
}

function peerNamedByResolutionFailure(error: unknown): OptionalGrpcPackage | undefined {
  if (!(error instanceof Error)) return undefined;
  const code =
    "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? String(error.code) : "";
  const message = `${code}\n${error.message}`;
  if (!RESOLUTION_FAILURE.test(message)) return undefined;
  return OPTIONAL_GRPC_PACKAGES.find((name) => message.includes(name));
}

function missingOptionalGrpcPeer(error: unknown): OptionalGrpcPackage | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (isGenuineGrpcFailure(current)) return undefined;
    const peer = peerNamedByResolutionFailure(current);
    if (peer) return peer;
    current = current.cause;
  }
  return undefined;
}

export function explainOptionalGrpcLoadFailure(error: unknown): unknown {
  const peer = missingOptionalGrpcPeer(error);
  if (!peer) return error;
  return new HonuaOptionalGrpcPeerError(peer, error);
}
