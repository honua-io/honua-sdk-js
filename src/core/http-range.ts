/** The byte span a `Content-Range: bytes start-end/total` header describes. */
export interface ContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

export function parseContentRange(value: string | null): ContentRange | undefined {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= 0) return undefined;
  return { start, end, total };
}

/** Stops a response body that will not be read, so the rest of it is never downloaded. */
export async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
