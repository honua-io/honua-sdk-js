import { describe, expect, it } from "vitest";

import { HonuaAgentExecutionError, HonuaAgentSafetyError } from "../src/agent-safety/index.js";
import type { AgentExecutionReceiptV1 } from "../src/agent-safety/index.js";
import { HonuaAgentToolError } from "../src/agent-tools/index.js";
import { HonuaGeneratedAppError } from "../src/generated-app/errors.js";
import { toGeneratedAppDiagnostic } from "../src/generated-app/index.js";
import {
  HONUA_ERROR_CODE_REGISTRY,
  HONUA_ERROR_KIND,
  HonuaSdkError,
  isHonuaError,
  serializeHonuaError,
} from "../src/index.js";

describe("agent-tools tagged SDK error envelope (HonuaAgentToolError)", () => {
  const CLASSIFICATIONS = [
    ["unknown-tool", "agent.tool.unknown-tool", "validation"],
    ["missing-runtime", "agent.tool.missing-runtime", "validation"],
    ["unqualified-selection", "agent.tool.unqualified-selection", "validation"],
    ["missing-runtime-method", "agent.tool.missing-runtime-method", "capability"],
  ] as const;

  it("classifies every known reason without changing its legacy contract", () => {
    for (const [code, sdkCode, category] of CLASSIFICATIONS) {
      const error = new HonuaAgentToolError(code, `message for ${code}`, { tool: "inspectMap" });

      expect(error.message).toBe(`message for ${code}`);
      expect(error.code).toBe(code);
      expect(error.tool).toBe("inspectMap");
      expect(error.name).toBe("HonuaAgentToolError");
      expect(error).toBeInstanceOf(HonuaAgentToolError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(error).toMatchObject({
        kind: HONUA_ERROR_KIND,
        domain: "agent",
        sdkCode,
        category,
        retryable: false,
        context: { tool: "inspectMap" },
      });
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "agent", category, retryable: false });
    }
  });

  it("omits context entirely when no tool name is supplied", () => {
    const error = new HonuaAgentToolError("missing-runtime", "no runtime available");
    expect(error.tool).toBeUndefined();
    expect(serializeHonuaError(error).context).toEqual({});
  });

  it("fails closed for unknown runtime codes without leaking them into serialized output", () => {
    const secretCode = "unknown-secret-reason-abc123";
    const error = new HonuaAgentToolError(secretCode, "unexpected failure");

    expect(error.code).toBe(secretCode);
    expect(error.sdkCode).toBe("agent.tool.internal");
    expect(error).toMatchObject({ domain: "agent", category: "internal", retryable: false });

    const serialized = serializeHonuaError(error);
    expect(serialized.code).toBe("agent.tool.internal");
    const json = JSON.stringify(serialized);
    expect(json).not.toContain(secretCode);
  });

  it("never serializes tool call arguments or results, even if a caller mistakenly passes them as the message", () => {
    const toolArgs = { where: "SECRET_QUERY_1=1", token: "Bearer super-secret-token" };
    const error = new HonuaAgentToolError("unqualified-selection", `denied for args ${JSON.stringify(toolArgs)}`, {
      tool: "selectFeature",
    });
    // The message is intentionally caller-controlled and stays local-only; only the
    // fixed tool-name identifier crosses into the envelope's serialized context.
    const serialized = serializeHonuaError(error);
    expect(serialized).not.toHaveProperty("message");
    expect(serialized.context).toEqual({ tool: "selectFeature" });
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("SECRET_QUERY_1");
    expect(json).not.toContain("super-secret-token");
  });
});

describe("agent-safety tagged SDK error envelope (HonuaAgentSafetyError)", () => {
  const CLASSIFICATIONS = [
    ["aborted", "agent.safety.aborted", "cancellation"],
    ["invalid-input", "agent.safety.invalid-input", "validation"],
    ["policy-denied", "agent.safety.policy-denied", "capability"],
    ["integrity-failed", "agent.safety.integrity-failed", "protocol"],
    ["approval-expired", "agent.safety.approval-expired", "authentication"],
    ["context-mismatch", "agent.safety.context-mismatch", "validation"],
    ["signature-invalid", "agent.safety.signature-invalid", "validation"],
    ["execution-failed", "agent.safety.execution-failed", "internal"],
    ["audit-failed", "agent.safety.audit-failed", "internal"],
    ["receipt-failed", "agent.safety.receipt-failed", "internal"],
  ] as const;

  it("classifies every registry failure without changing its legacy contract", () => {
    for (const [code, sdkCode, category] of CLASSIFICATIONS) {
      const error = new HonuaAgentSafetyError(code, `message for ${code}`);

      expect(error.message).toBe(`message for ${code}`);
      expect(error.code).toBe(code);
      expect(error.name).toBe("HonuaAgentSafetyError");
      expect(error).toBeInstanceOf(HonuaAgentSafetyError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(error).toMatchObject({
        kind: HONUA_ERROR_KIND,
        domain: "agent",
        sdkCode,
        category,
        retryable: false,
        context: {},
      });
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "agent", category, retryable: false });
    }
  });

  it("never serializes plan, policy, approval, or evidence payloads embedded in the message", () => {
    const sensitivePlan = {
      steps: [{ tool: "runWidgetQuery", parameters: { where: "ssn = '123-45-6789'" } }],
      actor: "user:soleil@honua.io",
    };
    const error = new HonuaAgentSafetyError("context-mismatch", `plan rejected: ${JSON.stringify(sensitivePlan)}`);
    const serialized = serializeHonuaError(error);
    expect(serialized).not.toHaveProperty("message");
    expect(serialized.context).toEqual({});
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("soleil@honua.io");
    expect(json).not.toContain("runWidgetQuery");
  });
});

describe("agent-safety tagged SDK error envelope (HonuaAgentExecutionError)", () => {
  function fakeReceipt(secret: string): AgentExecutionReceiptV1 {
    return {
      kind: "honua.agent-execution-receipt",
      version: "1.0",
      id: "receipt-1",
      stepId: "step-1",
      inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      useDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      consumption: {
        kind: "honua.agent-approval-consumption",
        version: "1.0",
        id: "consumption-1",
        nonce: "nonce-1",
        consumedAt: "2026-07-17T00:00:00.000Z",
        approvalDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        stepId: "step-1",
        inputDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: `opaque-token-${secret}`,
      },
      outcome: "succeeded",
      completedAt: "2026-07-17T00:00:01.000Z",
      rows: 3,
      bytes: 128,
      planDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      policyDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      bindingsDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      approvalDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      algorithm: "ed25519",
      keyId: `key-${secret}`,
      receiptDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111",
      signature: `signature-${secret}`,
    };
  }

  it("extends HonuaAgentSafetyError and preserves phase/receipt as local-only fields", () => {
    const receipt = fakeReceipt("receipt-secret");
    const error = new HonuaAgentExecutionError("execution-failed", "step execution failed", "execution", receipt);

    expect(error.name).toBe("HonuaAgentExecutionError");
    expect(error.code).toBe("execution-failed");
    expect(error.phase).toBe("execution");
    expect(error.receipt).toBe(receipt);
    expect(error).toBeInstanceOf(HonuaAgentExecutionError);
    expect(error).toBeInstanceOf(HonuaAgentSafetyError);
    expect(error).toBeInstanceOf(HonuaSdkError);
    expect(isHonuaError(error)).toBe(true);
    expect(error).toMatchObject({
      domain: "agent",
      sdkCode: "agent.safety.execution-failed",
      category: "internal",
      retryable: false,
    });
  });

  it("never serializes the signed execution receipt, even when it is attached to the error", () => {
    const receipt = fakeReceipt("do-not-leak-me");
    const error = new HonuaAgentExecutionError("audit-failed", "terminal audit failed", "terminal-audit", receipt);

    const serialized = serializeHonuaError(error);
    expect(serialized).not.toHaveProperty("receipt");
    expect(serialized).not.toHaveProperty("phase");
    expect(serialized.context).toEqual({});
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("do-not-leak-me");
    expect(json).not.toContain("opaque-token-do-not-leak-me");
    expect(json).not.toContain("signature-do-not-leak-me");

    // JSON.stringify(error) directly also must not walk into the receipt: the base
    // envelope's toJSON() is authoritative and receipt/phase are not enumerable
    // envelope fields.
    const directJson = JSON.stringify(error);
    expect(directJson).not.toContain("do-not-leak-me");
  });
});

describe("generated-app tagged SDK error envelope (HonuaGeneratedAppError)", () => {
  const CLASSIFICATIONS = [
    ["unsupported-profile", "app.unsupported-profile", "capability"],
    ["unsupported-widget", "app.unsupported-widget", "capability"],
    ["missing-manifest", "app.missing-manifest", "validation"],
    ["missing-manifest-artifact", "app.missing-manifest-artifact", "validation"],
    ["missing-map-package", "app.missing-map-package", "validation"],
    ["map-package-mismatch", "app.map-package-mismatch", "validation"],
    ["missing-widget", "app.missing-widget", "validation"],
    ["missing-binding", "app.missing-binding", "validation"],
    ["map-load-failed", "app.map-load-failed", "internal"],
    ["data-load-failed", "app.data-load-failed", "internal"],
    ["render-failed", "app.render-failed", "internal"],
    ["disposed", "app.disposed", "validation"],
  ] as const;

  it("classifies every stage/code pair without changing its legacy contract", () => {
    for (const [code, sdkCode, category] of CLASSIFICATIONS) {
      const error = new HonuaGeneratedAppError(code, `message for ${code}`, {
        stage: "load",
        detail: { appId: "app-1", widgetId: "widget-1" },
      });

      expect(error.message).toBe(`message for ${code}`);
      expect(error.code).toBe(code);
      expect(error.stage).toBe("load");
      expect(error.detail).toEqual({ appId: "app-1", widgetId: "widget-1" });
      expect(error.name).toBe("HonuaGeneratedAppError");
      expect(error).toBeInstanceOf(HonuaGeneratedAppError);
      expect(error).toBeInstanceOf(HonuaSdkError);
      expect(error).toBeInstanceOf(Error);
      expect(isHonuaError(error)).toBe(true);
      expect(error).toMatchObject({ kind: HONUA_ERROR_KIND, domain: "app", sdkCode, category, retryable: false });
      expect(HONUA_ERROR_CODE_REGISTRY[sdkCode]).toMatchObject({ domain: "app", category, retryable: false });
    }
  });

  it("preserves the legacy toGeneratedAppDiagnostic shape used by previewGeneratedApp", () => {
    const error = new HonuaGeneratedAppError("missing-widget", "operations dashboard is missing a widget", {
      stage: "projection",
      detail: { appId: "app-1", widgetId: "table" },
    });
    expect(toGeneratedAppDiagnostic(error)).toEqual({
      name: "HonuaGeneratedAppError",
      code: "missing-widget",
      stage: "projection",
      message: "operations dashboard is missing a widget",
      detail: { appId: "app-1", widgetId: "table" },
    });
  });

  it("never serializes the open caller-supplied detail bag, even when it carries feature values or credentials", () => {
    const error = new HonuaGeneratedAppError("data-load-failed", "feature data failed to load", {
      stage: "load",
      detail: {
        appId: "app-1",
        sourceId: "source-1",
        expected: { apiKey: "sk-live-secret-value", rows: [{ ssn: "123-45-6789" }] },
        received: { authorization: "Bearer super-secret-token" },
      },
      cause: new Error("connection string: postgres://user:password@host/db"),
    });

    const serialized = serializeHonuaError(error);
    expect(serialized).not.toHaveProperty("detail");
    expect(serialized).not.toHaveProperty("message");
    expect(serialized.context).toEqual({});
    expect(serialized.cause).toMatchObject({ name: "Error" });

    const json = JSON.stringify(serialized);
    for (const secret of ["sk-live-secret-value", "123-45-6789", "super-secret-token", "user:password@host"]) {
      expect(json).not.toContain(secret);
    }

    // The unsanitized diagnostic remains available locally via toGeneratedAppDiagnostic
    // for the preview host (unchanged legacy behavior) but is a distinct, explicit call —
    // never something JSON.stringify(error) or serializeHonuaError(error) does implicitly.
    expect(toGeneratedAppDiagnostic(error).detail).toMatchObject({ appId: "app-1", sourceId: "source-1" });

    // JSON.stringify(error) now uses the inherited envelope toJSON(), not the legacy
    // diagnostic shape, so it must not leak the raw detail bag either.
    const directJson = JSON.stringify(error);
    for (const secret of ["sk-live-secret-value", "123-45-6789", "super-secret-token", "user:password@host"]) {
      expect(directJson).not.toContain(secret);
    }
  });
});
