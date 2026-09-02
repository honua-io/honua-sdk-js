import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  StudioAiChatEvent,
  StudioAiChatRequest,
  StudioAiSignedTranscript,
} from "../src/studio-agent/ai-contract.js";
import { InMemoryStudioAiReplayStore, StudioAiTranscriptVerifier } from "../src/studio-agent/transcript-verifier.js";

const crypto = webcrypto as unknown as Crypto;
const encoder = new TextEncoder();
const b64 = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
};
const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

async function fixture() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const request: StudioAiChatRequest = {
    certification: {
      candidateId: "sha256:candidate",
      releaseId: "2026.1-rc.1",
      endpointIdentity: "candidate-proxy",
      actionId: "setup",
      runNonce: "nonce-1",
    },
    provider: "anthropic",
    model: "claude-sonnet",
    messages: [{ role: "user", content: "create the map" }],
  };
  const events: StudioAiChatEvent[] = [
    { type: "messageStart", model: "claude-sonnet" },
    { type: "toolCallStart", toolCallId: "call-1", toolName: "honua_studio_propose_operation" },
    { type: "toolCallStop", toolCallId: "call-1", toolArguments: { title: "map" } },
    { type: "messageStop", stopReason: "toolCall" },
  ];
  const issuedAt = new Date("2026-09-02T10:00:00Z");
  const transcript = encoder.encode(
    canonical({
      actionId: "setup",
      candidateId: "sha256:candidate",
      canonicalization: "honua-canonical-json-v1",
      digestAlgorithm: "sha-256",
      endpointIdentity: "candidate-proxy",
      expiresAt: "2026-09-02T10:05:00.0000000+00:00",
      issuedAt: "2026-09-02T10:00:00.0000000+00:00",
      keyId: "key-1",
      model: "claude-sonnet",
      provider: "anthropic",
      providerEvents: b64(encoder.encode(canonical(events))),
      releaseId: "2026.1-rc.1",
      request: b64(encoder.encode(canonical(request))),
      runNonce: "nonce-1",
      schemaVersion: "honua.studio-ai.transcript.v1",
      selectedResponse: "",
      terminalResultDigest: b64(await crypto.subtle.digest("SHA-256", encoder.encode(canonical(events)))),
    }),
  );
  const provenance: StudioAiSignedTranscript = {
    schemaVersion: "honua.studio-ai.transcript.v1",
    canonicalization: "honua-canonical-json-v1",
    digestAlgorithm: "sha-256",
    signatureAlgorithm: "Ed25519",
    keyId: "key-1",
    canonicalTranscript: b64(transcript),
    transcriptDigest: await digest(transcript),
    signature: b64(await crypto.subtle.sign("Ed25519", keys.privateKey, transcript)),
  };
  const replayStore = new InMemoryStudioAiReplayStore();
  const verifier = new StudioAiTranscriptVerifier({
    manifest: {
      requiredForCertification: true,
      keys: [
        {
          keyId: "key-1",
          algorithm: "Ed25519",
          publicKey: b64(publicKey),
          fingerprint: `sha256:${await digest(publicKey)}`,
          revoked: false,
        },
      ],
    },
    replayStore,
    now: () => issuedAt,
    crypto,
  });
  return { request, events, provenance, verifier };
}

describe("StudioAiTranscriptVerifier", () => {
  it("accepts the exact signed proxy transcript once and atomically rejects replay", async () => {
    const value = await fixture();
    await expect(value.verifier.verify(value.provenance, value.request, value.events)).resolves.toMatchObject({
      ok: true,
    });
    await expect(value.verifier.verify(value.provenance, value.request, value.events)).resolves.toEqual({
      ok: false,
      reason: "replay",
    });
  });

  it.each([
    [
      "text mutation",
      (value: Awaited<ReturnType<typeof fixture>>) =>
        value.events.splice(1, 0, { type: "textDelta", text: "tampered" }),
    ],
    [
      "tool mutation",
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.events[1] = { ...value.events[1], toolName: "direct_execute" };
      },
    ],
    [
      "binding mutation",
      (value: Awaited<ReturnType<typeof fixture>>) => {
        (value.request as { certification: unknown }).certification = {
          ...value.request.certification!,
          candidateId: "wrong",
        };
      },
    ],
    [
      "duplicate terminal",
      (value: Awaited<ReturnType<typeof fixture>>) =>
        value.events.push({ type: "messageStop", stopReason: "toolCall" }),
    ],
  ])("rejects %s before dispatch", async (_name, mutate) => {
    const value = await fixture();
    mutate(value);
    await expect(value.verifier.verify(value.provenance, value.request, value.events)).resolves.toMatchObject({
      ok: false,
    });
  });
});
