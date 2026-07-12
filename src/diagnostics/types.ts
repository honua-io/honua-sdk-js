export type DiagnosticContentClassification = "unknown" | "public" | "internal" | "customer-data" | "secret-suspected";

export interface DiagnosticConsent {
  redactionAcknowledged: boolean;
  shareWithSupport: boolean;
  grantedBy?: string;
}

export interface DiagnosticHeader {
  name: string;
  value: string;
}

export interface DiagnosticBodyPreview {
  preview?: string;
  contentSha256?: string;
  originalByteSize: number;
  redactionApplied: boolean;
  truncated: boolean;
}

export interface DiagnosticEnvelope {
  method: string;
  normalizedPath: string;
  statusCode?: number;
  mediaType?: string;
  correlationId?: string;
  traceId?: string;
  capturedAt?: string;
  requestHeaders?: DiagnosticHeader[];
  responseHeaders?: DiagnosticHeader[];
  requestBody?: DiagnosticBodyPreview;
  responseBody?: DiagnosticBodyPreview;
}

export interface DiagnosticBundleV1 {
  schemaVersion: "1.0";
  bundleId?: string;
  contentClassification: DiagnosticContentClassification;
  consent: DiagnosticConsent;
  envelopes: DiagnosticEnvelope[];
}

export interface DiagnosticExchangeInput {
  method: string;
  url: string;
  statusCode?: number;
  mediaType?: string;
  correlationId?: string;
  traceId?: string;
  capturedAt?: string;
  requestHeaders?: Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
  responseHeaders?: Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface CreateDiagnosticBundleOptions {
  bundleId?: string;
  contentClassification: DiagnosticContentClassification;
  consent: DiagnosticConsent;
  exchanges: readonly DiagnosticExchangeInput[];
  previewBytes?: number;
}

export interface DiagnosticValidationIssue {
  path: string;
  message: string;
}

export interface DiagnosticValidationResult {
  valid: boolean;
  issues: DiagnosticValidationIssue[];
}

export interface DiagnosticReplayOptions {
  bundle: unknown;
  baseUrl: string;
  envelopeIndex?: number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  previewBytes?: number;
}
