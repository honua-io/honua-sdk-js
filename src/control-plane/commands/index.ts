/**
 * Shared, idempotent application commands for the Honua control plane.
 *
 * One typed command layer behind every surface. The CLI, the MCP server,
 * Studio, and direct JS all call {@link HonuaCommandRuntime.execute} with the
 * same {@link HonuaCommand} objects and get back the same deterministic
 * {@link HonuaCommandReceipt}; transports adapt input and output only.
 *
 * ```ts
 * import {
 *   createHonuaCommandRuntime,
 *   mapPackagePublishCommand,
 * } from "@honua/sdk-js/control-plane";
 *
 * const runtime = createHonuaCommandRuntime({ client });
 * const receipt = await runtime.execute(
 *   mapPackagePublishCommand,
 *   { mapId: "map-ops", package: mapPackage },
 *   { transport: "sdk", identity: { actor: "user-1", tenantId: "acme" } },
 * );
 * receipt.auditKey; // identical for the equivalent `honua map publish` call
 * ```
 *
 * @experimental Reachable from the experimental
 *   `@honua/sdk-js/control-plane` entrypoint; not yet covered by the SDK's
 *   semver contract.
 * @module
 */

export {
  HONUA_COMMANDS,
  HONUA_COMMAND_IDS,
  connectionTestCommand,
  importCreateCommand,
  isHonuaCommandId,
  mapPackagePublishCommand,
  studioDraftSaveVersionCommand,
} from "./catalog.js";
export type {
  ConnectionTestInput,
  ConnectionTestOutput,
  HonuaCommandId,
  ImportCreateInput,
  MapPackagePublishInput,
  StudioDraftSaveVersionInput,
} from "./catalog.js";
export {
  HonuaCommandError,
  classifyCommandStatus,
  isHonuaCommandConflict,
  isHonuaCommandError,
  toHonuaCommandError,
} from "./errors.js";
export type {
  HonuaCommandErrorKind,
  HonuaCommandErrorOptions,
  HonuaCommandValidationIssue,
  SerializedHonuaCommandError,
} from "./errors.js";
export {
  canonicalCommandJson,
  commandDigest,
  deriveCorrelationId,
  deriveIdempotencyKey,
  honuaCommandAuditKey,
  honuaCommandReceiptProjection,
  normalizeCommandIdentity,
  serializeHonuaCommandReceipt,
} from "./identity.js";
export {
  HONUA_COMMAND_RESERVED_HEADERS,
  HonuaCommandRuntime,
  assertNoAuthorityOverride,
  createHonuaCommandRuntime,
} from "./runtime.js";
export type { HonuaCommandInvocation, HonuaCommandRuntimeOptions } from "./runtime.js";
export { HONUA_COMMAND_RECEIPT_KIND, HONUA_COMMAND_TRANSPORTS } from "./types.js";
export type {
  HonuaAnyCommand,
  HonuaCommand,
  HonuaCommandContext,
  HonuaCommandIdentity,
  HonuaCommandJsonSchema,
  HonuaCommandMode,
  HonuaCommandOutcome,
  HonuaCommandPlan,
  HonuaCommandReceipt,
  HonuaCommandResourceRef,
  HonuaCommandStatus,
  HonuaCommandTransport,
} from "./types.js";
export { validateCommandInput } from "./validate.js";
