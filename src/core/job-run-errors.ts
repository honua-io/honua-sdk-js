import type { JobStatus } from "../contract/jobs.js";
import { HonuaSdkError } from "./error-envelope.js";

/** Error thrown when `IJobRun.results()` observes a non-success terminal. */
export class HonuaJobFailedError extends HonuaSdkError {
  public readonly status: JobStatus;
  public readonly errorCode: string | undefined;
  public readonly details: unknown;

  public constructor(message: string, status: JobStatus, errorCode?: string, details?: unknown) {
    super("core.job-failed", message, { context: { status, errorCode } });
    this.name = "HonuaJobFailedError";
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}
