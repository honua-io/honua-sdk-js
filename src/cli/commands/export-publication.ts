import { setTimeout as delay } from "node:timers/promises";
import type { HonuaControlPlaneClient } from "../../control-plane/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getNumber } from "../args.js";
import { type ApiResponse, type ExportRecord, unwrapResponse } from "./export-response.js";

const DEFAULT_PUBLICATION_TIMEOUT_MS = 600_000;
const PUBLICATION_POLL_INTERVAL_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function publicationTimeout(parsed: ParsedArgs): number {
  const timeout = getNumber(parsed, "timeout-ms") ?? DEFAULT_PUBLICATION_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_DELAY_MS) {
    throw new ArgError("--timeout-ms must be a positive integer no greater than 2147483647.");
  }
  return timeout;
}

interface PublicationOptions {
  readonly controlPlane: HonuaControlPlaneClient;
  readonly created: ExportRecord;
  readonly timeoutMs: number;
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function publicPublication(record: ExportRecord): ExportRecord {
  if (record.message) throw new Error(`Export ${record.id} failed: ${record.message}`);
  if (record.status !== "ready" || !record.currentVersion || !isHttpUrl(record.publicUrl)) {
    throw new Error(
      `Export ${record.id} is not public: ${record.notPublicReason ?? `publication status is ${record.status}`}.`,
    );
  }
  return record;
}

async function pollPublicPublication(options: PublicationOptions, signal: AbortSignal): Promise<ExportRecord> {
  const { controlPlane, created } = options;
  for (;;) {
    const record = unwrapResponse(
      await controlPlane.raw<ApiResponse<ExportRecord>>({
        method: "GET",
        path: `/exports/${encodeURIComponent(created.id)}`,
        signal,
      }),
    );
    if (record.id !== created.id || record.jobId !== created.jobId) {
      throw new Error(
        `The server no longer reports submitted export job ${created.jobId}; public publication is unconfirmed.`,
      );
    }
    if (record.status !== "running" || record.message) return publicPublication(record);
    await delay(PUBLICATION_POLL_INTERVAL_MS, undefined, { signal });
  }
}

export async function waitForPublicPublication(options: PublicationOptions): Promise<ExportRecord> {
  const { created, timeoutMs } = options;
  if (created.status !== "running") return publicPublication(created);
  if (!created.id || !created.jobId) throw new Error("The server did not identify the submitted export job.");
  const controller = new AbortController();
  const timeoutError = new Error(
    `Timed out waiting for public export ${created.id} (job ${created.jobId}). The job may still finish; check honua export list.`,
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    return await pollPublicPublication(options, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
