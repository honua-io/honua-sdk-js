import type {
  StudioAiChatEvent,
  StudioAiChatRequest,
  StudioAiSignedTranscript,
  StudioAiTranscriptCertification,
  StudioAiTranscriptSigningManifest,
} from "./ai-contract.js";

export interface StudioAiReplayStore {
  /** Atomically inserts a digest. False means it was already consumed. */
  consume(transcriptDigest: string): boolean | Promise<boolean>;
}

export class InMemoryStudioAiReplayStore implements StudioAiReplayStore {
  readonly #consumed = new Set<string>();
  public consume(digest: string): boolean {
    if (this.#consumed.has(digest)) return false;
    this.#consumed.add(digest);
    return true;
  }
}

export interface StudioAiTranscriptVerifierOptions {
  readonly manifest: StudioAiTranscriptSigningManifest;
  readonly replayStore: StudioAiReplayStore;
  readonly now?: () => Date;
  readonly crypto?: Crypto;
}

export interface StudioAiTranscriptVerification {
  readonly ok: boolean;
  readonly reason?: string;
  readonly transcriptDigest?: string;
}

export interface StudioAiTranscriptVerifierLike {
  verify(
    provenance: StudioAiSignedTranscript,
    request: StudioAiChatRequest,
    events: readonly StudioAiChatEvent[],
  ): Promise<StudioAiTranscriptVerification>;
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sameBinding(value: Record<string, unknown>, binding: StudioAiTranscriptCertification): boolean {
  return (
    value.candidateId === binding.candidateId &&
    value.releaseId === binding.releaseId &&
    value.endpointIdentity === binding.endpointIdentity &&
    value.actionId === binding.actionId &&
    value.runNonce === binding.runNonce
  );
}

/** Independently verifies every server binding before atomically consuming replay state. */
export class StudioAiTranscriptVerifier implements StudioAiTranscriptVerifierLike {
  readonly #options: StudioAiTranscriptVerifierOptions;
  public constructor(options: StudioAiTranscriptVerifierOptions) {
    this.#options = options;
  }

  public async verify(
    provenance: StudioAiSignedTranscript,
    request: StudioAiChatRequest,
    events: readonly StudioAiChatEvent[],
  ): Promise<StudioAiTranscriptVerification> {
    const fail = (reason: string): StudioAiTranscriptVerification => ({ ok: false, reason });
    if (
      provenance.schemaVersion !== "honua.studio-ai.transcript.v1" ||
      provenance.canonicalization !== "honua-canonical-json-v1" ||
      provenance.digestAlgorithm !== "sha-256" ||
      provenance.signatureAlgorithm !== "Ed25519"
    ) {
      return fail("unsupported-provenance-contract");
    }
    const key = this.#options.manifest.keys.find((candidate) => candidate.keyId === provenance.keyId);
    if (!key) return fail("unknown-key");
    const now = (this.#options.now ?? (() => new Date()))();
    if (key.revoked) return fail("revoked-key");
    if ((key.notBefore && now < new Date(key.notBefore)) || (key.notAfter && now > new Date(key.notAfter))) {
      return fail("key-outside-validity-window");
    }
    const cryptoImpl = this.#options.crypto ?? globalThis.crypto;
    const transcriptBytes = base64Bytes(provenance.canonicalTranscript);
    if (transcriptBytes.length === 0) return fail("malformed-transcript");
    const digest = hex(await cryptoImpl.subtle.digest("SHA-256", transcriptBytes));
    if (digest !== provenance.transcriptDigest.toLowerCase()) return fail("transcript-digest-mismatch");
    const publicKey = base64Bytes(key.publicKey);
    const fingerprint = `sha256:${hex(await cryptoImpl.subtle.digest("SHA-256", publicKey))}`;
    if (fingerprint !== key.fingerprint.toLowerCase()) return fail("key-fingerprint-mismatch");
    let signatureValid = false;
    try {
      const imported = await cryptoImpl.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
      signatureValid = await cryptoImpl.subtle.verify(
        "Ed25519",
        imported,
        base64Bytes(provenance.signature),
        transcriptBytes,
      );
    } catch {
      return fail("signature-verification-failed");
    }
    if (!signatureValid) return fail("invalid-signature");
    let transcript: Record<string, unknown>;
    try {
      transcript = JSON.parse(new TextDecoder().decode(transcriptBytes)) as Record<string, unknown>;
    } catch {
      return fail("malformed-transcript");
    }
    if (!request.certification || !sameBinding(transcript, request.certification)) return fail("binding-mismatch");
    if (transcript.keyId !== provenance.keyId) return fail("key-binding-mismatch");
    if (
      transcript.provider !== request.provider ||
      transcript.model !== events.find((event) => event.type === "messageStart")?.model
    ) {
      return fail("provider-model-mismatch");
    }
    const issuedAt = new Date(String(transcript.issuedAt));
    const expiresAt = new Date(String(transcript.expiresAt));
    if (
      !Number.isFinite(issuedAt.valueOf()) ||
      !Number.isFinite(expiresAt.valueOf()) ||
      now < issuedAt ||
      now > expiresAt
    ) {
      return fail("expired-envelope");
    }
    const signedRequest = new TextDecoder().decode(base64Bytes(String(transcript.request)));
    if (signedRequest !== canonicalJson(request)) return fail("request-mismatch");
    const signedEvents = new TextDecoder().decode(base64Bytes(String(transcript.providerEvents)));
    if (signedEvents !== canonicalJson(events)) return fail("terminal-events-mismatch");
    const terminal = events.filter((event) => event.type === "messageStop" || event.type === "error");
    if (terminal.length !== 1 || events.at(-1) !== terminal[0] || terminal[0]?.type !== "messageStop")
      return fail("invalid-terminal-sequence");
    if (!(await this.#options.replayStore.consume(digest))) return fail("replay");
    return { ok: true, transcriptDigest: digest };
  }
}
