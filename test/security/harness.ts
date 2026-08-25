/**
 * Shared harness for the deterministic security-eval suite (`test/security/`).
 *
 * Two things every eval in this directory needs and must not reimplement:
 *
 * 1. **A recording transport.** Every case drives the *real* shipped client
 *    over a `fetchFn` that records what actually went on the wire. Nothing in
 *    this suite asserts that a guard "ran" — the guards are proven by the
 *    request list being empty, or by the recorded bytes not containing the
 *    planted secret.
 * 2. **A byte-level absence check.** `wireBytes` flattens a recorded request
 *    list (method, URL, every header name and value, the serialized body) into
 *    one string so a test can assert a credential literal appears *nowhere*.
 *    Asserting on a parsed field would miss a secret that leaked into a query
 *    parameter, a header the test did not think to name, or an error string.
 *
 * There is no network, no model, no clock dependence, and no filesystem
 * mutation anywhere in `test/security/`.
 *
 * @module
 */

import { HonuaClient } from "../../src/index.js";

/** One request as it actually left the client. */
export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string | undefined;
  readonly body: unknown;
}

export interface RecordedResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Recorder {
  readonly requests: CapturedRequest[];
  readonly fetchFn: typeof fetch;
}

/**
 * A `fetch` that records every request and answers from `respond`.
 *
 * `respond` receives the captured request and the zero-based attempt index, so
 * a bound-driving test can hand back a fresh cursor forever (or a never-terminal
 * status forever) and let the client's own cap be the thing that stops the loop.
 */
export function recorder(
  respond: (request: CapturedRequest, index: number) => RecordedResponse = () => ({}),
): Recorder {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [name, value] of headerEntries(init?.headers)) headers[name.toLowerCase()] = value;
    const rawBody = typeof init?.body === "string" && init.body.length > 0 ? init.body : undefined;
    const request: CapturedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: url.toString(),
      path: url.pathname,
      search: url.search,
      headers,
      rawBody,
      body: rawBody ? safeJson(rawBody) : undefined,
    };
    requests.push(request);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const reply = respond(request, requests.length - 1);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

export interface RecordingClient extends Recorder {
  readonly client: HonuaClient;
}

/** A real {@link HonuaClient} bound to a recording transport. */
export function recordingClient(
  options: { readonly apiKey?: string; readonly baseUrl?: string } = {},
  respond?: (request: CapturedRequest, index: number) => RecordedResponse,
): RecordingClient {
  const capture = recorder(respond);
  const client = new HonuaClient({
    baseUrl: options.baseUrl ?? "https://control.example.test",
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    fetchFn: capture.fetchFn,
    transport: "rest",
  });
  return { client, requests: capture.requests, fetchFn: capture.fetchFn };
}

/**
 * Everything the client put on the wire, flattened into one string.
 *
 * Header *names* are included as well as values so a test can prove an
 * authority header was never even attempted, not merely that it carried no
 * value.
 */
export function wireBytes(requests: readonly CapturedRequest[]): string {
  return requests
    .map((request) => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
      return [request.method, request.url, headers, request.rawBody ?? ""].join("\n");
    })
    .join("\n\n");
}

/** UTF-8 bytes of an arbitrary serializable value, for a byte-level scan. */
export function utf8Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Planted credential literals.
 *
 * Every one is a *syntactically real* credential shape — a JWT with three
 * base64url segments, an `AKIA`-prefixed AWS access-key id, a GitHub PAT — so a
 * scanner that only recognizes the shape (rather than this exact string) still
 * has to catch it. None of these is a live credential: the AWS id is the
 * documented all-`A` example form and the JWT payload decodes to `{"a":"b"}`.
 */
export const PLANTED = {
  bearer: "Bearer AbCdEf0123456789abcdefXYZ",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.c2lnbmF0dXJlLXZhbHVl",
  awsKeyId: "AKIAAAAAAAAAAAAAAAAA",
  githubPat: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  apiKeyValue: "hnu_live_0123456789abcdefghijklmnop",
  signedUrl: "https://tiles.example.test/z/x/y.pbf?sig=aBcD3fGh1JkLmN0pQrStUv&se=2026-12-31",
  userinfoUrl: "https://svc-user:s3cr3t-p4ssw0rd@features.example.test/collections",
  adminKey: "honua-root-admin-key-DO-NOT-SHARE-0123456789",
} as const;

function headerEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [String(name), String(value)]);
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
