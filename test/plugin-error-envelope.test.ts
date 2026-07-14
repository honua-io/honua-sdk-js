import { describe, expect, it } from "vitest";

import {
  HONUA_ERROR_CODE_REGISTRY,
  HONUA_ERROR_KIND,
  HonuaSdkError,
  isHonuaError,
  serializeHonuaError,
} from "../src/index.js";
import { HonuaPluginRegistryError } from "../src/plugin/index.js";

const CLASSIFICATIONS = [
  ["PLUGIN_ABORT_SIGNAL_INVALID", "plugin.registry.validation", "validation"],
  ["PLUGIN_DEPENDENCY_DUPLICATE", "plugin.registry.validation", "validation"],
  ["PLUGIN_BATCH_INVALID", "plugin.registry.validation", "validation"],
  ["PLUGIN_BATCH_SPARSE", "plugin.registry.validation", "validation"],
  ["PLUGIN_REGISTRY_DISPOSED", "plugin.registry.validation", "validation"],
  ["PLUGIN_DUPLICATE_ID", "plugin.registry.validation", "validation"],
  ["PLUGIN_DEPENDENCY_CYCLE", "plugin.registry.validation", "validation"],
  ["PLUGIN_HOST_REJECTED", "plugin.compatibility", "capability"],
  ["PLUGIN_CERTIFICATION_FAILED", "plugin.compatibility", "capability"],
  ["PLUGIN_DEPENDENCY_VERSION_CONFLICT", "plugin.compatibility", "capability"],
  ["PLUGIN_DEPENDENCY_KIND_CONFLICT", "plugin.compatibility", "capability"],
  ["PLUGIN_NETWORK_ORIGIN_DENIED", "plugin.execution.policy-denied", "capability"],
  ["PLUGIN_CREDENTIAL_SCOPE_DENIED", "plugin.execution.policy-denied", "capability"],
  ["PLUGIN_ABORT_SIGNAL_UNAVAILABLE", "plugin.capability-unavailable", "capability"],
  ["PLUGIN_DEPENDENCY_MISSING", "plugin.capability-unavailable", "capability"],
  ["PLUGIN_DISPOSE_HOOK_REQUIRED", "plugin.lifecycle.activation", "internal"],
  ["PLUGIN_REGISTRATION_FAILED", "plugin.lifecycle.activation", "internal"],
  ["PLUGIN_NETWORK_URL_INVALID", "plugin.execution.validation", "validation"],
  ["PLUGIN_DISPOSAL_FAILED", "plugin.lifecycle.cleanup", "internal"],
  ["PLUGIN_REGISTRATION_CANCELLED", "plugin.cancelled", "cancellation"],
  ["PLUGIN_REVALIDATION_FAILED", "plugin.internal", "internal"],
] as const;

describe("plugin tagged SDK error envelope", () => {
  it("classifies every registry failure without changing its legacy contract", () => {
    for (const [code, sdkCode, category] of CLASSIFICATIONS) {
      const error = new HonuaPluginRegistryError(code);

      expect(error.message).toBe(code);
      expect(error.code).toBe(code);
      expect(error.name).toBe("HonuaPluginRegistryError");
      expect(error).toBeInstanceOf(HonuaPluginRegistryError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(error).toMatchObject({
        kind: HONUA_ERROR_KIND,
        domain: "plugin",
        sdkCode,
        category,
        retryable: false,
        context: { reasonCode: code },
      });
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({
        domain: "plugin",
        category,
        retryable: false,
      });
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  it("keeps causes and frozen cleanup aggregates local to the instance", () => {
    const cause = {
      authorization: "Bearer cause-secret",
      manifest: { configurationSecret: "manifest-secret" },
    };
    const firstCleanupFailure = new Error("cleanup-secret-one");
    const secondCleanupFailure = { payload: "cleanup-secret-two" };
    const cleanupErrors: unknown[] = [firstCleanupFailure];
    const error = new HonuaPluginRegistryError("PLUGIN_REGISTRATION_FAILED", {
      cause,
      cleanupErrors,
    });
    cleanupErrors.push(secondCleanupFailure);

    expect(error.cause).toBe(cause);
    expect(error.cleanupErrors).not.toBe(cleanupErrors);
    expect(error.cleanupErrors).toEqual([firstCleanupFailure]);
    expect(error.cleanupErrors[0]).toBe(firstCleanupFailure);
    expect(Object.isFrozen(error.cleanupErrors)).toBe(true);
    expect(Reflect.set(error.cleanupErrors, "0", secondCleanupFailure)).toBe(false);

    const serialized = serializeHonuaError(error);
    expect(serialized).toMatchObject({
      name: "HonuaPluginRegistryError",
      domain: "plugin",
      code: "plugin.lifecycle.activation",
      category: "internal",
      retryable: false,
      context: { reasonCode: "PLUGIN_REGISTRATION_FAILED" },
      cause: { name: "object" },
    });
    expect(serialized).not.toHaveProperty("message");
    expect(serialized).not.toHaveProperty("cleanupErrors");
    const json = JSON.stringify(serialized);
    for (const secret of ["cause-secret", "manifest-secret", "cleanup-secret-one", "cleanup-secret-two"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("fails closed for unknown runtime codes without coercing or serializing them", () => {
    const unknownString = "PLUGIN_PRIVATE_manifest-secret";
    let coercionAttempted = false;
    const unknownObject = {
      payload: "runtime-object-secret",
      [Symbol.toPrimitive]() {
        coercionAttempted = true;
        throw new Error("runtime-coercion-secret");
      },
    };
    const stringError = new HonuaPluginRegistryError(unknownString);
    const objectError = new HonuaPluginRegistryError(unknownObject as unknown as string);

    expect(stringError.message).toBe(unknownString);
    expect(stringError.code).toBe(unknownString);
    expect(objectError.message).toBe("PLUGIN_UNKNOWN");
    expect(objectError.code).toBe(unknownObject);
    expect(coercionAttempted).toBe(false);

    for (const error of [stringError, objectError]) {
      expect(error).toMatchObject({
        sdkCode: "plugin.internal",
        context: { reasonCode: "PLUGIN_UNKNOWN" },
      });
      const json = JSON.stringify(error);
      for (const secret of ["manifest-secret", "runtime-object-secret", "runtime-coercion-secret"]) {
        expect(json).not.toContain(secret);
      }
    }
    expect(coercionAttempted).toBe(false);
  });
});
