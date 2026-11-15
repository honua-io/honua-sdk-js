/**
 * Optional gRPC-Web peers are not part of a REST install. Resolution failures
 * for those packages become an actionable error only after `transport:
 * "grpc-web"` has actually loaded them. Connect/RPC failures are returned
 * unchanged so a real gRPC error is not relabeled as a missing install.
 */

const OPTIONAL_GRPC_PACKAGES = ["@connectrpc/connect-web", "@connectrpc/connect", "@bufbuild/protobuf"] as const;

/**
 * Module-loader failures as Node and each browser word them (Chromium: "Failed to
 * resolve module specifier", Firefox: "bare specifier ... not remapped", Safari:
 * "does not resolve to a valid URL" / "Importing a module script failed").
 */
const RESOLUTION_FAILURE =
  /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Failed to resolve module specifier|bare specifier|does not resolve to a valid URL|Importing a module script failed|dynamically imported module|Cannot find package|Cannot find module/;

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

function resolutionFailureText(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code =
    "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? String(error.code) : "";
  const message = `${code}\n${error.message}`;
  return RESOLUTION_FAILURE.test(message) ? message : undefined;
}

function peerNamedByResolutionFailure(error: unknown): OptionalGrpcPackage | undefined {
  const message = resolutionFailureText(error);
  return message === undefined ? undefined : OPTIONAL_GRPC_PACKAGES.find((name) => message.includes(name));
}

/** Walk the cause chain until `read` finds something, stopping at a genuine gRPC failure. */
function scanLoadFailure<T>(error: unknown, read: (current: unknown) => T | undefined): T | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (isGenuineGrpcFailure(current)) return undefined;
    const found = read(current);
    if (found !== undefined) return found;
    current = current.cause;
  }
  return undefined;
}

function missingOptionalGrpcPeer(error: unknown): OptionalGrpcPackage | undefined {
  return scanLoadFailure(error, peerNamedByResolutionFailure);
}

/**
 * True when the gRPC-Web runtime, its peers or its adapter modules could not be
 * loaded, whether or not the failure names a peer. A genuine gRPC failure (for
 * example an auth error wrapped as `HonuaGrpcError`) is never a load failure.
 */
export function isGrpcRuntimeLoadFailure(error: unknown): boolean {
  if (error instanceof HonuaOptionalGrpcPeerError) return true;
  return (
    scanLoadFailure(error, (current) => (resolutionFailureText(current) === undefined ? undefined : true)) === true
  );
}

export function explainOptionalGrpcLoadFailure(error: unknown): unknown {
  const peer = missingOptionalGrpcPeer(error);
  if (!peer) return error;
  return new HonuaOptionalGrpcPeerError(peer, error);
}
