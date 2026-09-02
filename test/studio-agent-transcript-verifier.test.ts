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
  const manifest = {
    requiredForCertification: true as const,
    keys: [
      {
        keyId: "key-1",
        algorithm: "Ed25519" as const,
        publicKey: b64(publicKey),
        fingerprint: `sha256:${await digest(publicKey)}`,
        revoked: false,
      },
    ],
  };
  const verifier = new StudioAiTranscriptVerifier({
    manifest,
    replayStore,
    now: () => issuedAt,
    crypto,
  });
  return { request, events, provenance, verifier, manifest, issuedAt };
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

  it.each([
    [
      "unsupported contract",
      (value: Awaited<ReturnType<typeof fixture>>) => ({
        provenance: { ...value.provenance, signatureAlgorithm: "RSA" as "Ed25519" },
      }),
    ],
    [
      "unknown key",
      (value: Awaited<ReturnType<typeof fixture>>) => ({
        provenance: { ...value.provenance, keyId: "missing" },
      }),
    ],
    [
      "malformed transcript",
      (value: Awaited<ReturnType<typeof fixture>>) => ({
        provenance: { ...value.provenance, canonicalTranscript: "%%%" },
      }),
    ],
    [
      "digest mismatch",
      (value: Awaited<ReturnType<typeof fixture>>) => ({
        provenance: { ...value.provenance, transcriptDigest: "00".repeat(32) },
      }),
    ],
    [
      "invalid signature",
      (value: Awaited<ReturnType<typeof fixture>>) => ({
        provenance: { ...value.provenance, signature: b64(new Uint8Array(64)) },
      }),
    ],
  ])("rejects an envelope with %s", async (_name, mutate) => {
    const value = await fixture();
    const changed = mutate(value);
    await expect(value.verifier.verify(changed.provenance, value.request, value.events)).resolves.toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["revoked key", { revoked: true }, (value: Awaited<ReturnType<typeof fixture>>) => value.issuedAt],
    [
      "future key",
      { notBefore: "2026-09-02T10:01:00Z" },
      (value: Awaited<ReturnType<typeof fixture>>) => value.issuedAt,
    ],
    [
      "expired key",
      { notAfter: "2026-09-02T09:59:00Z" },
      (value: Awaited<ReturnType<typeof fixture>>) => value.issuedAt,
    ],
    [
      "fingerprint mismatch",
      { fingerprint: "sha256:deadbeef" },
      (value: Awaited<ReturnType<typeof fixture>>) => value.issuedAt,
    ],
  ] as const)("rejects a %s", async (_name, keyPatch, clock) => {
    const value = await fixture();
    const verifier = new StudioAiTranscriptVerifier({
      manifest: { ...value.manifest, keys: [{ ...value.manifest.keys[0]!, ...keyPatch }] },
      replayStore: new InMemoryStudioAiReplayStore(),
      now: () => clock(value),
      crypto,
    });
    await expect(verifier.verify(value.provenance, value.request, value.events)).resolves.toMatchObject({ ok: false });
  });
});
