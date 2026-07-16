/**
 * Full public Honua SDK error envelope.
 *
 * Leaf error classes import `error-base.ts`, which carries only their local
 * classification and redaction boundary. Importing this module explicitly
 * retains the complete cross-realm runtime classifications and serializer
 * semantics. Human-readable registry descriptors remain a separate explicit
 * import.
 */

import {
  HONUA_ERROR_KIND,
  type HonuaErrorEnvelopeContext,
  type HonuaSdkError,
  type SerializedHonuaError,
  type SerializedHonuaErrorCause,
  emptyContext,
  errorNameWithoutGetters,
  isPlainHonuaErrorContext,
  isRecord,
  ownDataProperty,
  sanitizeErrorName,
  sanitizeHonuaErrorContext,
  sanitizeIdentifier,
  serializeLocalHonuaError,
} from "./error-base.js";
import { HONUA_ERROR_RUNTIME_CLASSIFICATIONS } from "./error-classifications.js";
import type { HonuaErrorCode } from "./error-code-registry.js";
import type { HonuaError } from "./errors.js";

type MutableSerializedHonuaError = { -readonly [Key in keyof SerializedHonuaError]: SerializedHonuaError[Key] };

export {
  HONUA_ERROR_KIND,
  HonuaSdkError,
  isRetryableNetworkOrTimeoutHonuaError,
  mergeHonuaErrorContext,
  sanitizeHonuaErrorContext,
} from "./error-base.js";
export type {
  HonuaErrorCategory,
  HonuaErrorCode,
  HonuaErrorCodeDescriptor,
  HonuaErrorDomain,
  HonuaErrorEnvelopeContext,
  HonuaErrorEnvelopeContextValue,
  HonuaErrorMetadata,
  HonuaErrorOptions,
  SerializedHonuaError,
  SerializedHonuaErrorCause,
} from "./error-base.js";
/** True when a string is present in the complete governed error-code registry. */
export function isHonuaErrorCode(code: string): code is HonuaErrorCode {
  return Object.hasOwn(HONUA_ERROR_RUNTIME_CLASSIFICATIONS, code);
}

/** Serialize a tagged SDK error without crossing its redaction boundary. */
export function serializeHonuaError(error: HonuaSdkError): SerializedHonuaError {
  const local = serializeLocalHonuaError(error);
  if (local) return local;
  const sdkCode = ownDataProperty(error, "sdkCode");
  if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) {
    throw new TypeError("Cannot serialize an SDK error with an unregistered code");
  }
  const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
  const cause = serializeCause(ownDataProperty(error, "cause"));
  const operationId = sanitizeIdentifier(ownDataProperty(error, "operationId"));
  const requestId = sanitizeIdentifier(ownDataProperty(error, "requestId"));
  const context = ownDataProperty(error, "context");
  const serialized: MutableSerializedHonuaError = {
    kind: HONUA_ERROR_KIND,
    name: sanitizeErrorName(ownDataProperty(error, "name")),
    domain,
    code: sdkCode,
    category,
    retryable,
    context: isPlainHonuaErrorContext(context) ? sanitizeHonuaErrorContext(context) : emptyContext(),
  };
  if (operationId) serialized.operationId = operationId;
  if (requestId) serialized.requestId = requestId;
  if (cause) serialized.cause = cause;
  return serialized;
}

/** Cross-realm type guard backed by the public tag and complete governed code registry. */
export function isHonuaSdkError(error: unknown): error is HonuaSdkError {
  try {
    if (!isRecord(error) || Array.isArray(error)) return false;
    const kind = ownDataProperty(error, "kind");
    const sdkCode = ownDataProperty(error, "sdkCode");
    if (kind !== HONUA_ERROR_KIND || typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return false;
    const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
    const context = ownDataProperty(error, "context");
    const name = ownDataProperty(error, "name");
    return (
      ownDataProperty(error, "domain") === domain &&
      ownDataProperty(error, "retryable") === retryable &&
      ownDataProperty(error, "category") === category &&
      typeof name === "string" &&
      isPlainHonuaErrorContext(context)
    );
  } catch {
    return false;
  }
}

/** Public cross-realm guard retaining the established root API signature. */
export function isHonuaError(error: unknown): error is HonuaError {
  return isHonuaSdkError(error);
}

function serializeCause(cause: unknown): SerializedHonuaErrorCause | undefined {
  if (cause === undefined) return undefined;
  try {
    if (isHonuaSdkError(cause)) {
      const sdkCode = ownDataProperty(cause, "sdkCode") as HonuaErrorCode;
      const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
      return {
        name: sanitizeErrorName(ownDataProperty(cause, "name")),
        domain,
        code: sdkCode,
        category,
        retryable,
      };
    }
    if (cause instanceof Error) return { name: errorNameWithoutGetters(cause) };
    return { name: typeof cause };
  } catch {
    return { name: "Error" };
  }
}
