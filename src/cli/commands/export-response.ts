export interface ExportSource {
  readonly kind: string;
  readonly serviceId?: string;
  readonly layerId?: number;
  readonly name?: string;
}

export interface ExportRecord {
  readonly id: string;
  readonly title: string;
  readonly source: ExportSource;
  readonly currentVersion?: string;
  readonly status: string;
  readonly collectionUrl?: string;
  readonly publicUrl?: string;
  readonly notPublicReason?: string;
  readonly jobId?: string;
  readonly message?: string;
}

export interface ExportListResponse {
  readonly items: readonly ExportRecord[];
}

export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly message?: string;
}

function problemMessage(problem: unknown): string | undefined {
  if (typeof problem !== "object" || problem === null) return undefined;
  const candidate = (problem as { readonly message?: unknown }).message;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function unwrapResponse<T>(
  result:
    | { readonly supported: true; readonly value: ApiResponse<T> }
    | { readonly supported: false; readonly reason: string; readonly problem?: unknown },
): T {
  if (!result.supported) {
    throw new Error(problemMessage(result.problem) ?? result.reason);
  }
  if (!result.value?.success || result.value.data == null) {
    throw new Error(result.value?.message ?? "The server returned an invalid export response.");
  }
  return result.value.data;
}
