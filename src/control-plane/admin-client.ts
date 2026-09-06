import { trimTrailingSlashes } from "../core/path-utils.js";
import type { operations } from "./generated/admin-api.js";
import { ADMIN_API_BASE_PATH, ADMIN_OPERATIONS, type AdminOperationId } from "./generated/admin-operations.js";

type Operation<Id extends AdminOperationId> = operations[Id];
type OperationParameters<Id extends AdminOperationId> = Operation<Id> extends {
  parameters: infer Parameters;
}
  ? Parameters
  : never;
type ParameterValue<
  Id extends AdminOperationId,
  Kind extends "header" | "path" | "query",
> = OperationParameters<Id> extends { [Key in Kind]?: infer Value } ? Exclude<Value, undefined> : never;
type RequiredRequestBody<Id extends AdminOperationId> = Operation<Id> extends {
  requestBody: infer RequestBody;
}
  ? RequestBody
  : never;
type OptionalRequestBody<Id extends AdminOperationId> = Operation<Id> extends {
  requestBody?: infer RequestBody;
}
  ? Exclude<RequestBody, undefined>
  : never;
type RequestBodyContent<RequestBody> = RequestBody extends { content: infer Content } ? Content : never;
type ContentValue<Content> = Content extends Record<PropertyKey, unknown> ? Content[keyof Content] : never;

export type AdminOperationRequestBody<Id extends AdminOperationId> = ContentValue<
  RequestBodyContent<RequiredRequestBody<Id> | OptionalRequestBody<Id>>
>;
export type AdminOperationContentType<Id extends AdminOperationId> = Extract<
  keyof RequestBodyContent<RequiredRequestBody<Id> | OptionalRequestBody<Id>>,
  string
>;

type OptionalField<Name extends string, Value> = [Value] extends [never]
  ? { readonly [Key in Name]?: never }
  : { readonly [Key in Name]?: Value };
type RequiredField<Name extends string, Value> = [Value] extends [never]
  ? { readonly [Key in Name]?: never }
  : { readonly [Key in Name]: Value };
type BodyField<Id extends AdminOperationId> = [RequiredRequestBody<Id>] extends [never]
  ? [OptionalRequestBody<Id>] extends [never]
    ? { readonly body?: never; readonly contentType?: never }
    : {
        readonly body?: AdminOperationRequestBody<Id>;
        readonly contentType?: AdminOperationContentType<Id>;
      }
  : {
      readonly body: AdminOperationRequestBody<Id>;
      readonly contentType?: AdminOperationContentType<Id>;
    };

export type AdminOperationRequest<Id extends AdminOperationId> = RequiredField<"path", ParameterValue<Id, "path">> &
  OptionalField<"query", ParameterValue<Id, "query">> &
  OptionalField<"headers", ParameterValue<Id, "header"> & HeadersInit> &
  BodyField<Id> & {
    readonly signal?: AbortSignal;
  };

type SuccessStatus<Status> = Status extends number
  ? `${Status}` extends `2${string}`
    ? Status
    : never
  : Status extends `${2}${string}`
    ? Status
    : never;
type ResponseContent<Response> = Response extends { content: infer Content } ? ContentValue<Content> : undefined;
type SuccessResponsePayload<Responses> = {
  [Status in keyof Responses]: SuccessStatus<Status> extends never ? never : ResponseContent<Responses[Status]>;
}[keyof Responses];

export type AdminOperationResponse<Id extends AdminOperationId> = Operation<Id> extends {
  responses: infer Responses;
}
  ? SuccessResponsePayload<Responses>
  : never;

export interface AdminClientOptions {
  readonly baseUrl: string;
  /** Scoped API key; sent as `X-API-Key`. */
  readonly apiKey?: string;
  /** Root/admin key. Takes precedence over `apiKey`. */
  readonly adminKey?: string;
  readonly basePath?: string;
  readonly fetchFn?: typeof fetch;
  readonly headers?: HeadersInit;
}

export interface AdminOperationResult<Id extends AdminOperationId> {
  readonly operationId: Id;
  readonly data: AdminOperationResponse<Id>;
  readonly response: Response;
}

export class HonuaAdminApiError extends Error {
  public readonly operationId: AdminOperationId;
  public readonly statusCode: number;
  public readonly body: unknown;

  public constructor(operationId: AdminOperationId, response: Response, body: unknown) {
    const detail = structuredErrorDetail(body);
    super(`Admin operation ${operationId} failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
    this.name = "HonuaAdminApiError";
    this.operationId = operationId;
    this.statusCode = response.status;
    this.body = body;
  }
}

function structuredErrorDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const detail = [record.detail, record.message, record.title].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (detail) return detail;
  if (record.errors !== undefined) {
    try {
      return JSON.stringify(record.errors);
    } catch {
      return "The server returned structured validation errors.";
    }
  }
  return undefined;
}

/**
 * Complete generated Admin REST client. Curated clients may wrap this surface,
 * but every operation in the pinned OpenAPI contract remains callable here.
 */
export class HonuaAdminClient {
  readonly #baseUrl: string;
  readonly #basePath: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Headers;
  readonly #credential: string | undefined;

  public constructor(options: AdminClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Admin client baseUrl must use http or https.");
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("Admin client baseUrl must not include credentials, query parameters, or a fragment.");
    }
    if (baseUrl.protocol === "http:" && !isLoopbackHost(baseUrl.hostname)) {
      throw new Error("Admin client requires HTTPS except for exact loopback HTTP development endpoints.");
    }
    this.#baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.#basePath = normalizeBasePath(options.basePath ?? ADMIN_API_BASE_PATH);
    this.#fetch = options.fetchFn ?? fetch;
    this.#headers = new Headers(options.headers);
    this.#credential = options.adminKey ?? options.apiKey;
    if (this.#credential) this.#headers.set("X-API-Key", this.#credential);
  }

  public async call<Id extends AdminOperationId>(
    operationId: Id,
    request: AdminOperationRequest<Id>,
  ): Promise<AdminOperationResult<Id>> {
    const descriptor = ADMIN_OPERATIONS[operationId];
    const path = interpolatePath(descriptor.path, request.path as Record<string, unknown> | undefined);
    const url = new URL(`${this.#baseUrl}${this.#basePath}${path}`);
    appendQuery(url, request.query as Record<string, unknown> | undefined);

    const headers = new Headers(this.#headers);
    mergeHeaders(headers, request.headers as HeadersInit | undefined);
    if (this.#credential) headers.set("X-API-Key", this.#credential);
    const body = encodeBody(
      request.body,
      request.contentType as string | undefined,
      headers,
      descriptor.requestContentTypes,
    );
    const response = await this.#fetch(url, {
      method: descriptor.method,
      headers,
      body,
      signal: request.signal,
      redirect: "manual",
    });
    const data = await readResponse(response);
    if (!response.ok) throw new HonuaAdminApiError(operationId, response, data);
    return { operationId, data: data as AdminOperationResponse<Id>, response };
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function createHonuaAdminClient(options: AdminClientOptions): HonuaAdminClient {
  return new HonuaAdminClient(options);
}

/** Enforce the admin credential transport policy for command-layer requests. */
export function assertAdminBaseUrl(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Admin client baseUrl must use http or https.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Admin client baseUrl must not include credentials, query parameters, or a fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Admin client requires HTTPS except for exact loopback HTTP development endpoints.");
  }
}

function normalizeBasePath(value: string): string {
  const rooted = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlashes(rooted);
}

function interpolatePath(template: string, parameters: Record<string, unknown> | undefined): string {
  const used = new Set<string>();
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parameters?.[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required admin path parameter: ${name}`);
    }
    used.add(name);
    return encodeURIComponent(String(value));
  });
  for (const name of Object.keys(parameters ?? {})) {
    if (!used.has(name)) throw new Error(`Unknown admin path parameter for ${template}: ${name}`);
  }
  return path;
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, String(item));
    } else {
      url.searchParams.set(name, String(value));
    }
  }
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) return;
  for (const [name, value] of new Headers(source)) target.set(name, value);
}

function encodeBody(
  value: unknown,
  contentType: string | undefined,
  headers: Headers,
  declaredContentTypes: readonly string[],
): BodyInit | null {
  if (value === undefined) return null;
  const selected = contentType ?? defaultRequestContentType(declaredContentTypes);
  if (selected === "multipart/form-data") return toFormData(value);
  headers.set("Content-Type", selected);
  if (selected.includes("json")) return JSON.stringify(value);
  if (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams
  ) {
    return value as BodyInit;
  }
  return String(value);
}

function defaultRequestContentType(declaredContentTypes: readonly string[]): string {
  if (declaredContentTypes.includes("application/json")) return "application/json";
  return declaredContentTypes[0] ?? "application/json";
}

function toFormData(value: unknown): FormData {
  if (value instanceof FormData) return value;
  if (typeof value !== "object" || value === null) throw new Error("multipart/form-data body must be an object.");
  const form = new FormData();
  for (const [name, field] of Object.entries(value)) {
    if (field === undefined || field === null) continue;
    if (Array.isArray(field)) {
      for (const item of field) form.append(name, formValue(item));
    } else {
      form.append(name, formValue(field));
    }
  }
  return form;
}

function formValue(value: unknown): string | Blob {
  if (value instanceof Blob) return value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) return response.json();
  if (contentType.startsWith("text/") || contentType.includes("xml")) return response.text();
  return response.arrayBuffer();
}
