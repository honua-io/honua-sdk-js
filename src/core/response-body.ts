import { HonuaAbortError, HonuaNetworkError } from "./errors.js";

export class ResponseBodyLimitError extends HonuaNetworkError {
  public constructor(
    maximum: number,
    public readonly receivedBytes: number,
  ) {
    super(`Response body exceeds the configured ${maximum}-byte limit.`, undefined);
  }
}

function checkResponseLength(response: Response, maximum: number, signal?: AbortSignal): void {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new HonuaAbortError();
  }
  const advertised = response.headers.get("content-length");
  const length = advertised === null ? 0 : Number(advertised);
  if (Number.isFinite(length) && length > maximum) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError(maximum, length);
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  checkResponseLength(response, maximum, signal);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new HonuaAbortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new HonuaAbortError();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError(maximum, total);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw new HonuaAbortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return concatenateChunks(chunks, total);
}

function concatenateChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
