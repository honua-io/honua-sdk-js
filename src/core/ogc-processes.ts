/**
 * OGC API Processes surface. Process discovery, execution, and async
 * job tracking against any conformant Part 1 (Core) server — a raw
 * third-party deployment discovered by `discoverOgcProcesses()` just as much
 * as the Honua facade. Per the ticket constraint, executions return an
 * `IJobRun` (the canonical async-operation surface) rather than an
 * OGC-specific job type; a synchronous execution returns an already-terminal
 * `IJobRun` so callers read results through one surface either way.
 *
 * Three properties keep the standalone lane honest:
 *
 * 1. **Nothing is assumed about the layout.** Routes template off the
 *    discovered service root, and the job lifecycle prefers the server's own
 *    `Location` header and `links[]` over the Core path template.
 * 2. **Capability gaps fail closed.** When the server's conformance
 *    declaration (or the process's `jobControlOptions`) is known and does not
 *    declare what the caller asked for, the call throws
 *    `HonuaCapabilityNotSupportedError` naming the missing construct rather
 *    than posting and hoping.
 * 3. **Polling is bounded.** `results()` always runs under a budget — the
 *    caller's, the handle's, or a default deadline — and honors an
 *    `AbortSignal`.
 *
 * @module
 */

import type {
  IJobRun,
  JobError,
  JobProgress,
  JobResult,
  JobResultsOptions,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "../contract/jobs.js";
import { HonuaJobPollTimeoutError, isJobTerminal } from "../contract/jobs.js";
import type { HonuaClient } from "./client.js";
import { HonuaSdkError } from "./error-envelope.js";
import { HonuaCapabilityNotSupportedError } from "./errors.js";
import { hasOgcConformanceClass } from "./ogc-conformance.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import type {
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcLink,
  HonuaOgcProcessDescription,
  HonuaOgcProcessJobAccepted,
  HonuaOgcProcessJobResults,
  HonuaOgcProcessJobStatus,
  HonuaOgcProcessesResponse,
  OgcMetadataRequest,
  OgcProcessExecuteRequest,
  OgcProcessJobRequest,
  OgcProcessStatus,
} from "./types.js";
import { createOgcMetadataParams, mergeHeaders } from "./wire-shared.js";

/**
 * Conformance declaration as advertised at `/conformance`. Structurally
 * satisfied by `HonuaOgcConformanceResponse` and by the
 * `discoverOgcProcesses()` result, so either can be handed straight to a
 * processes handle.
 */
export interface HonuaOgcProcessesConformanceInput {
  readonly conformsTo?: readonly string[];
}

export interface HonuaOgcProcessesOptions {
  client: HonuaClient;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/processes`). */
  basePath?: string;
  /**
   * The server's advertised conformance classes. Supply the
   * `discoverOgcProcesses()` result (or a `/conformance` response) to gate
   * execution and dismissal against what the server actually declares.
   * Omitted under the default policy, nothing is gated on conformance.
   */
  conformance?: HonuaOgcProcessesConformanceInput;
  /**
   * How hard to gate on server declarations.
   *
   * - `"advertised"` (default) — gate on declarations already in hand
   *   (`conformance`, a `describe()` already performed on this handle, or an
   *   explicit `jobControlOptions`), and fall back to the Core-mandated route
   *   templates when a server advertises no link. No extra requests; existing
   *   callers and the Honua facade are unaffected.
   * - `"strict"` — resolve the conformance declaration and the process
   *   description first (both through the metadata cache) and refuse anything
   *   the server has not declared, including a job lifecycle whose status and
   *   results routes are not advertised as links.
   */
  capabilityPolicy?: "advertised" | "strict";
  /**
   * Default polling budget applied to `results()` on jobs created by this
   * handle. Per-call {@link JobResultsOptions} win field by field.
   */
  pollBudget?: JobResultsOptions;
}

export interface HonuaOgcProcessJobOptions {
  client: HonuaClient;
  jobId: string;
  /** Process identifier the job was created from, when known. */
  processId?: string;
  /** Initial server snapshot, as returned from `executeOgcProcess`. */
  initialStatus?: HonuaOgcProcessJobStatus;
  /** Default `pollIntervalMs` for `results()`. */
  pollIntervalMs?: number;
  /** Override of the default polling behavior; useful in tests. */
  pollFn?: (jobId: string, signal?: AbortSignal) => Promise<HonuaOgcProcessJobStatus>;
  /** Raw endpoint path prefix (defaults to the Honua facade `/ogc/processes`). */
  basePath?: string;
  /** Server-advertised status route (same-origin path), when the server published one. */
  statusPath?: string;
  /** Server-advertised results route (same-origin path), when the server published one. */
  resultsPath?: string;
  /** Default polling budget; per-call {@link JobResultsOptions} win field by field. */
  pollBudget?: JobResultsOptions;
  /** Advertised conformance, used to gate `cancel()` on the Dismiss class. */
  conformance?: HonuaOgcProcessesConformanceInput;
  /** The originating process's advertised `jobControlOptions`, when known. */
  jobControlOptions?: readonly string[];
  /** See {@link HonuaOgcProcessesOptions.capabilityPolicy}. */
  capabilityPolicy?: "advertised" | "strict";
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Wall-clock ceiling applied to `results()` when neither the caller nor the
 * handle set `deadlineMs` / `maxAttempts`. NFR-001: a status endpoint that
 * never reaches a terminal state must not poll forever. Callers who genuinely
 * want a longer wait pass their own `deadlineMs`.
 */
const DEFAULT_POLL_DEADLINE_MS = 600_000;

/** Honua facade path prefix for OGC API Processes. */
const PROCESSES_FACADE_BASE = "/ogc/processes";

/**
 * OGC API — Processes Part 1 (1.0) conformance classes the SDK gates on, and
 * the Core link relations the job lifecycle follows. These stay module-private
 * per the `ogc-conformance` rule that conformance URIs are never top-level SDK
 * types; they surface only as diagnostic strings inside capability errors, so a
 * refusal can name the exact construct the server did not declare.
 */
const PROCESSES_CONFORMANCE = {
  core: "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
  dismiss: "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss",
} as const;

/** Substring matchers tolerant of OGC re-issuing the class URIs under a new part number. */
const PROCESSES_CONFORMANCE_MATCH = {
  core: "processes-1/1.0/conf/core",
  dismiss: "processes-1/1.0/conf/dismiss",
} as const;

const PROCESSES_LINK_REL = {
  results: "http://www.opengis.net/def/rel/ogc/1.0/results",
  status: "self",
} as const;

/** Job-control options a process declares in its description (Core §7.9). */
const JOB_CONTROL = {
  sync: "sync-execute",
  async: "async-execute",
  dismiss: "dismiss",
} as const;

/**
 * Fail-closed refusal naming the construct the server did not declare. The
 * conformance-class URI / link relation rides in the error context so telemetry
 * keeps it after redaction.
 *
 * The context key for a class URI is `missingClass`, not `conformanceClass`:
 * the error-envelope redactor drops any key matching `form` (for form bodies),
 * which "con**form**anceClass" hits — the value would ship as `[REDACTED]` and
 * the refusal would name nothing.
 */
function capabilityRefusal(
  capability: string,
  sourceId: string | undefined,
  context: Record<string, string>,
): HonuaCapabilityNotSupportedError {
  return new HonuaCapabilityNotSupportedError(capability, "ogc-processes", sourceId, { context });
}

/** `true` when the declaration list contains `option` (case-insensitive). */
function declares(options: readonly string[] | undefined, option: string): boolean {
  if (!options) return false;
  for (const entry of options) {
    if (typeof entry === "string" && entry.toLowerCase() === option) return true;
  }
  return false;
}

/**
 * Resolve the OGC API Processes path prefix: the caller-supplied raw `basePath`
 * (a `discoverOgcProcesses()`-discovered third-party service root) or the Honua
 * facade default. Trailing slashes are trimmed so a discovered root and the
 * facade compose the same sub-paths. Mirrors the OGC API Records seam.
 */
function processesBase(request: { basePath?: string }): string {
  // An omitted basePath uses the Honua facade; an explicit "" is a legitimate
  // root-mounted raw service and must NOT fall back to the facade prefix.
  if (request.basePath === undefined) return PROCESSES_FACADE_BASE;
  const base = request.basePath;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end--;
  return base.slice(0, end);
}

/**
 * Cache-key discriminator so a discovered root never collides with the facade.
 *
 * The base path is percent-encoded because cache keys join their components
 * with `:` and a service root may legally contain one. Without encoding,
 * `{ basePath: "/a", processId: "b:c" }` and `{ basePath: "/a:b", processId: "c" }`
 * would produce the same key for two different request URLs, so a cached
 * `describe()` could answer with the wrong process's metadata.
 */
function processesBaseKey(request: { basePath?: string }): string {
  const base = processesBase(request);
  return base === PROCESSES_FACADE_BASE ? "" : `${encodeURIComponent(base)}:`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Absolute URL of a request the SDK issues against `baseUrl`. Link hrefs in the
 * response are relative to the document that carried them, so this is the base
 * a `links[]` entry resolves against.
 */
function requestUrlFor(baseUrl: string, path: string): string | undefined {
  if (!isAbsoluteHttpUrl(baseUrl)) return undefined;
  try {
    return new URL(`${baseUrl}${path}`).toString();
  } catch {
    return undefined;
  }
}

/**
 * Reduce a server-advertised href to a same-origin request path.
 *
 * The SDK attaches credentials by header, so a link that leaves the configured
 * origin is dropped rather than followed — the caller falls back to the Core
 * route template (or, under `"strict"`, gets a fail-closed refusal). Relative
 * hrefs resolve against the document that carried them.
 */
function advertisedRoutePath(
  href: string | undefined,
  documentUrl: string | undefined,
  baseUrl: string,
): string | undefined {
  if (typeof href !== "string" || href.length === 0) return undefined;
  if (!isAbsoluteHttpUrl(baseUrl)) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(href, documentUrl ?? `${baseUrl}/`);
  } catch {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  if (resolved.origin !== origin) return undefined;
  return `${resolved.pathname}${resolved.search}`;
}

/** Core-mandated job route (§7.12) under a service root. */
function templatedJobPath(basePath: string | undefined, jobId: string): string {
  return `${processesBase({ ...(basePath !== undefined ? { basePath } : {}) })}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Append metadata params to a route that may already carry a query string —
 * an advertised job link often does. The server's own query is preserved
 * verbatim (never re-encoded) and a param it already declares is never
 * duplicated, so following a link cannot corrupt the URL the server published.
 */
function withParams(path: string, params: URLSearchParams): string {
  const queryIndex = path.indexOf("?");
  if (queryIndex < 0) {
    const query = params.toString();
    return query.length === 0 ? path : `${path}?${query}`;
  }
  const existing = new URLSearchParams(path.slice(queryIndex + 1));
  const additions = new URLSearchParams();
  for (const [key, value] of params) {
    if (!existing.has(key)) additions.append(key, value);
  }
  const query = additions.toString();
  return query.length === 0 ? path : `${path}&${query}`;
}

/**
 * First same-origin path advertised under one of `rels`, if any. A relation
 * matches on the full URI or on its last path segment, the same tolerance
 * `findOgcLink` applies — servers publish both
 * `http://www.opengis.net/def/rel/ogc/1.0/results` and a bare `results`.
 */
function linkPath(
  links: readonly HonuaOgcLink[] | undefined,
  documentUrl: string | undefined,
  baseUrl: string,
  ...rels: string[]
): string | undefined {
  if (!links) return undefined;
  const wanted = new Set<string>();
  for (const rel of rels) {
    const lower = rel.toLowerCase();
    wanted.add(lower);
    wanted.add(lower.slice(lower.lastIndexOf("/") + 1));
  }
  for (const link of links) {
    const rel = (link.rel ?? "").toLowerCase();
    const tail = rel.slice(rel.lastIndexOf("/") + 1);
    if (!wanted.has(rel) && !(tail && wanted.has(tail))) continue;
    const path = advertisedRoutePath(link.href, documentUrl, baseUrl);
    if (path) return path;
  }
  return undefined;
}

/** Top-level OGC API Processes handle. */
export class HonuaOgcProcesses {
  public readonly client: HonuaClient;
  private readonly basePath: string | undefined;
  private readonly capabilityPolicy: "advertised" | "strict";
  private readonly pollBudget: JobResultsOptions | undefined;
  private declaredConformance: HonuaOgcProcessesConformanceInput | undefined;
  private conformancePromise: Promise<HonuaOgcProcessesConformanceInput> | undefined;
  /**
   * `jobControlOptions` learned from `describe()` calls made through this
   * handle. Callers that follow the natural discover → describe → execute flow
   * therefore get process-level gating for free, with no extra round trip.
   */
  private readonly jobControlByProcess = new Map<string, readonly string[]>();

  public constructor(options: HonuaOgcProcessesOptions) {
    this.client = options.client;
    this.basePath = options.basePath;
    this.capabilityPolicy = options.capabilityPolicy ?? "advertised";
    this.pollBudget = options.pollBudget;
    this.declaredConformance = options.conformance;
  }

  private withBase<T extends { basePath?: string }>(request: T): T {
    return this.basePath !== undefined ? { ...request, basePath: this.basePath } : request;
  }

  public async landing(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return this.client.getOgcProcessesLanding(this.withBase(request));
  }

  public async conformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const response = await this.client.getOgcProcessesConformance(this.withBase(request));
    if (Array.isArray(response?.conformsTo)) this.declaredConformance = response;
    return response;
  }

  public async list(request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessesResponse> {
    const response = await this.client.listOgcProcesses(this.withBase(request));
    for (const process of response?.processes ?? []) {
      if (process?.id && process.jobControlOptions) {
        this.jobControlByProcess.set(process.id, [...process.jobControlOptions]);
      }
    }
    return response;
  }

  public async describe(processId: string, request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessDescription> {
    const description = await this.client.getOgcProcess(this.withBase({ ...request, processId }));
    if (description?.jobControlOptions) {
      this.jobControlByProcess.set(processId, [...description.jobControlOptions]);
    }
    return description;
  }

  /**
   * Submit a process for execution and return an `IJobRun` — always, so the
   * caller reads results through one surface whichever Core response shape the
   * server chose:
   *
   * - asynchronous (`Prefer: respond-async`, or the server's own default) →
   *   a pollable run bound to the advertised job routes.
   * - synchronous (`200` with the results document) → an already-terminal run
   *   whose `results()` resolves immediately with zero further requests.
   *
   * Before anything is posted, `mode` is gated against what the server has
   * declared: the Core conformance class when a conformance declaration is in
   * hand, and the process's `jobControlOptions` when the description is (from
   * `request.jobControlOptions`, an earlier `describe()`/`list()` on this
   * handle, or — under `capabilityPolicy: "strict"` — a cached `describe()`
   * performed here). An undeclared mode fails closed with
   * `HonuaCapabilityNotSupportedError`.
   */
  public async execute<T = unknown>(request: OgcProcessExecuteRequest): Promise<IJobRun<T>> {
    const executeRequest = this.withBase(request);
    const conformance = await this.assertExecutionDeclared(request);
    const accepted = await this.client.executeOgcProcess(executeRequest);
    const processId = accepted.processID ?? request.processId;
    const jobControlOptions = request.jobControlOptions ?? this.jobControlByProcess.get(request.processId);

    if (accepted.synchronous === true) {
      // Core assigns no job identifier to a synchronous execution; the results
      // document is already in hand, so the run starts terminal.
      return new HonuaOgcProcessSyncRun<T>(processId, (accepted.results ?? {}) as Record<string, T>);
    }

    return new HonuaOgcProcessJobRun<T>({
      client: this.client,
      jobId: accepted.jobID,
      processId,
      initialStatus: accepted.statusInfo ?? {
        jobID: accepted.jobID,
        processID: processId,
        status: accepted.status,
      },
      // The job routes live under the same root the execution was posted to;
      // a job created against a discovered root must never poll the facade.
      ...(executeRequest.basePath !== undefined ? { basePath: executeRequest.basePath } : {}),
      ...(accepted.statusPath !== undefined ? { statusPath: accepted.statusPath } : {}),
      ...(this.pollBudget !== undefined ? { pollBudget: this.pollBudget } : {}),
      ...(conformance !== undefined ? { conformance } : {}),
      ...(jobControlOptions !== undefined ? { jobControlOptions } : {}),
      capabilityPolicy: this.capabilityPolicy,
    });
  }

  /** Adopt an existing job by id (useful when reconnecting after navigation). */
  public job<T = unknown>(
    jobId: string,
    options: { processId?: string; basePath?: string; statusPath?: string; resultsPath?: string } = {},
  ): IJobRun<T> {
    const { basePath } = this.withBase(options);
    const jobControlOptions = options.processId ? this.jobControlByProcess.get(options.processId) : undefined;
    return new HonuaOgcProcessJobRun<T>({
      client: this.client,
      jobId,
      processId: options.processId,
      ...(basePath !== undefined ? { basePath } : {}),
      ...(options.statusPath !== undefined ? { statusPath: options.statusPath } : {}),
      ...(options.resultsPath !== undefined ? { resultsPath: options.resultsPath } : {}),
      ...(this.pollBudget !== undefined ? { pollBudget: this.pollBudget } : {}),
      ...(this.declaredConformance !== undefined ? { conformance: this.declaredConformance } : {}),
      ...(jobControlOptions !== undefined ? { jobControlOptions } : {}),
      capabilityPolicy: this.capabilityPolicy,
    });
  }

  /**
   * Resolve the conformance declaration. Under `"advertised"` only what the
   * caller already supplied (or a `conformance()` call made through this
   * handle) counts; under `"strict"` the declaration is fetched once through
   * the metadata cache so a refusal can be grounded in the server's own words.
   */
  private async resolveConformance(signal?: AbortSignal): Promise<HonuaOgcProcessesConformanceInput | undefined> {
    if (this.declaredConformance) return this.declaredConformance;
    if (this.capabilityPolicy !== "strict") return undefined;
    if (!this.conformancePromise) {
      const request: OgcMetadataRequest = signal ? { signal } : {};
      this.conformancePromise = this.client
        .getOgcProcessesConformance(this.withBase(request))
        .then((response) => {
          this.declaredConformance = response;
          return response as HonuaOgcProcessesConformanceInput;
        })
        .catch((error: unknown) => {
          this.conformancePromise = undefined;
          throw error;
        });
    }
    return this.conformancePromise;
  }

  /**
   * Fail closed when the server has not declared what the caller asked for.
   * Returns the conformance declaration (when one is in hand) so the created
   * job run can reuse it to gate `cancel()`.
   */
  private async assertExecutionDeclared(
    request: OgcProcessExecuteRequest,
  ): Promise<HonuaOgcProcessesConformanceInput | undefined> {
    const conformance = await this.resolveConformance(request.signal);
    if (conformance?.conformsTo && !hasOgcConformanceClass(conformance, PROCESSES_CONFORMANCE_MATCH.core)) {
      throw capabilityRefusal("processes.execute", request.processId, {
        missingClass: PROCESSES_CONFORMANCE.core,
        construct: "execute",
      });
    }

    const mode = request.mode ?? "auto";
    // `auto` asserts nothing about sync vs async: the server picks, and both
    // shapes land on the same `IJobRun`. Only an explicit preference is gated.
    if (mode === "auto") return conformance;

    let jobControlOptions = request.jobControlOptions ?? this.jobControlByProcess.get(request.processId);
    if (!jobControlOptions && this.capabilityPolicy === "strict") {
      const description = await this.describe(request.processId, request.signal ? { signal: request.signal } : {});
      jobControlOptions = description.jobControlOptions;
    }
    if (!jobControlOptions) return conformance;

    const required = mode === "sync" ? JOB_CONTROL.sync : JOB_CONTROL.async;
    if (!declares(jobControlOptions, required)) {
      throw capabilityRefusal(`processes.${required}`, request.processId, {
        construct: required,
        declaredJobControlOptions: jobControlOptions.join(","),
      });
    }
    return conformance;
  }
}

/**
 * `IJobRun` implementation backed by OGC API Processes 1.0 status / result
 * endpoints. Watchers receive the latest `JobSnapshot` when status,
 * progress, or terminal result changes; cancel is idempotent and races
 * the server's `dismissed` response against any concurrent terminal
 * transition.
 */
export class HonuaOgcProcessJobRun<T = unknown> implements IJobRun<T> {
  public readonly id: string;
  public readonly type: string;

  private readonly client: HonuaClient;
  private readonly basePath: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly pollFn: (jobId: string, signal?: AbortSignal) => Promise<HonuaOgcProcessJobStatus>;
  private readonly pollBudget: JobResultsOptions | undefined;
  private readonly conformance: HonuaOgcProcessesConformanceInput | undefined;
  private readonly jobControlOptions: readonly string[] | undefined;
  private readonly capabilityPolicy: "advertised" | "strict";
  /** Server-advertised routes, refreshed from every `links[]` the job reports. */
  private statusPath: string | undefined;
  private resultsPath: string | undefined;
  private currentStatus: JobStatus;
  private currentProgress: JobProgress | undefined;
  private terminalSnapshot: JobSnapshot<T> | undefined;
  private terminalPromise: Promise<JobResult<T>> | undefined;
  private readonly listeners = new Set<JobSnapshotListener<T>>();

  public constructor(options: HonuaOgcProcessJobOptions) {
    this.client = options.client;
    this.id = options.jobId;
    this.type = options.processId ?? options.initialStatus?.processID ?? "unknown";
    this.basePath = options.basePath;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollBudget = options.pollBudget;
    this.conformance = options.conformance;
    this.jobControlOptions = options.jobControlOptions;
    this.capabilityPolicy = options.capabilityPolicy ?? "advertised";
    this.statusPath = options.statusPath;
    this.resultsPath = options.resultsPath;
    this.pollFn = options.pollFn ?? ((jobId, signal) => this.fetchStatus(jobId, signal));
    const initial = options.initialStatus;
    this.absorbLinks(initial?.links);
    this.currentStatus = (initial?.status as JobStatus) ?? "accepted";
    this.currentProgress = progressFromOgcStatus(initial);
  }

  private async fetchStatus(jobId: string, signal?: AbortSignal): Promise<HonuaOgcProcessJobStatus> {
    if (this.capabilityPolicy === "strict" && this.statusPath === undefined) {
      throw capabilityRefusal("processes.jobStatusLink", this.type, {
        construct: "job status route",
        linkRelation: PROCESSES_LINK_REL.status,
      });
    }
    return this.client.getOgcProcessJob({
      jobId,
      ...(signal ? { signal } : {}),
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
      ...(this.statusPath !== undefined ? { routePath: this.statusPath } : {}),
    });
  }

  /**
   * Adopt the routes the server advertises on a job document. Every poll can
   * refresh them, so a server that only publishes its results link once the
   * job succeeds is still followed rather than path-guessed.
   */
  private absorbLinks(links: readonly HonuaOgcLink[] | undefined): void {
    if (!links || links.length === 0) return;
    const baseUrl = this.client.serverBaseUrl;
    const documentUrl = requestUrlFor(baseUrl, this.statusPath ?? templatedJobPath(this.basePath, this.id));
    const results = linkPath(links, documentUrl, baseUrl, PROCESSES_LINK_REL.results);
    if (results) this.resultsPath = results;
    if (this.statusPath === undefined) {
      const status = linkPath(links, documentUrl, baseUrl, PROCESSES_LINK_REL.status, "status", "monitor");
      if (status) this.statusPath = status;
    }
  }

  public get status(): JobStatus {
    return this.currentStatus;
  }

  public get progress(): JobProgress | undefined {
    return this.currentProgress;
  }

  public async poll(): Promise<JobSnapshot<T>> {
    if (this.terminalSnapshot) {
      return this.terminalSnapshot;
    }
    const ogcStatus = await this.pollFn(this.id);
    return this.handleOgcStatus(ogcStatus);
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async results(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    if (!this.terminalPromise) {
      // Reset the cached promise if the poll loop rejects (abort / deadline /
      // attempt cap) so a later results() call can retry rather than being
      // permanently poisoned by a transient cancellation.
      this.terminalPromise = this.runUntilTerminal(this.resolveBudget(options)).catch((error) => {
        this.terminalPromise = undefined;
        throw error;
      });
    }
    return this.terminalPromise;
  }

  /**
   * Layer the caller's bounds over the handle's default budget, then guarantee
   * a bound exists. NFR-001: `results()` is never an unbounded retry loop, so a
   * caller that names neither a deadline nor an attempt cap still inherits
   * {@link DEFAULT_POLL_DEADLINE_MS}.
   */
  private resolveBudget(options: JobResultsOptions): JobResultsOptions {
    const merged: JobResultsOptions = { ...this.pollBudget, ...options };
    if (merged.deadlineMs !== undefined || merged.maxAttempts !== undefined) return merged;
    return { ...merged, deadlineMs: DEFAULT_POLL_DEADLINE_MS };
  }

  public async cancel(): Promise<JobStatus> {
    if (this.terminalSnapshot) {
      return this.currentStatus;
    }
    this.assertDismissDeclared();
    try {
      // DELETE targets the job resource itself, so it follows the same
      // advertised route the status polls use rather than re-templating it.
      const cancelled = await this.client.cancelOgcProcessJob(this.jobRequest(this.statusPath));
      const snapshot = await this.handleOgcStatus(cancelled);
      return snapshot.status;
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
      // `IJobRun.cancel` is documented as idempotent: when the job is
      // already gone (404), return the cached status. honua-server uses
      // 409 for three distinct cases — only the terminal-race case is
      // benign:
      //   - "Cannot dismiss completed job" → terminal race; poll for the
      //     authoritative terminal status and return it.
      //   - "Dismiss could not be confirmed" → backend dismissal request
      //     was issued but did not confirm; rethrow so callers can retry.
      //   - "Cancellation not supported" → backend lacks cancel support;
      //     rethrow so callers can branch.
      // Any 409 with an unknown title also rethrows. The terminal-race
      // branch only swallows the 409 when the follow-up poll reaches a
      // terminal status; a non-terminal poll or a poll failure means the
      // "completed job" claim cannot be confirmed and the original 409
      // is the most honest signal.
      if (statusCode === 404) {
        return this.currentStatus;
      }
      if (statusCode === 409 && isCompletedJobConflict(error)) {
        let fresh: HonuaOgcProcessJobStatus;
        try {
          fresh = await this.pollFn(this.id);
        } catch {
          // Server claimed the job is in a terminal state but the
          // follow-up poll could not confirm it. Surface the original
          // 409 instead of letting the poll-side error swallow it.
          throw error;
        }
        const snapshot = await this.handleOgcStatus(fresh);
        if (!isJobTerminal(snapshot.status)) {
          throw error;
        }
        return snapshot.status;
      }
      throw error;
    }
  }

  private async runUntilTerminal(options: JobResultsOptions = {}): Promise<JobResult<T>> {
    const { signal } = options;
    const baseIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
    const maxIntervalMs = options.maxPollIntervalMs ?? Math.max(baseIntervalMs, 30_000);
    const startedAt = Date.now();
    let attempts = 0;

    while (!this.terminalSnapshot) {
      if (signal?.aborted) {
        throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
      }
      if (options.maxAttempts !== undefined && attempts >= options.maxAttempts) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.maxAttempts} poll attempt(s)`,
          "max-attempts",
          this.id,
          this.currentStatus,
        );
      }

      let ogcStatus: HonuaOgcProcessJobStatus;
      try {
        ogcStatus = await this.pollFn(this.id, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new HonuaJobPollTimeoutError(`Job ${this.id} poll aborted`, "aborted", this.id, this.currentStatus);
        }
        throw error;
      }
      attempts += 1;
      await this.handleOgcStatus(ogcStatus);
      if (this.terminalSnapshot) break;

      if (options.deadlineMs !== undefined && Date.now() - startedAt >= options.deadlineMs) {
        throw new HonuaJobPollTimeoutError(
          `Job ${this.id} did not reach a terminal state within ${options.deadlineMs}ms`,
          "deadline",
          this.id,
          this.currentStatus,
        );
      }

      // Capped exponential backoff instead of a fixed interval.
      const intervalMs = Math.min(maxIntervalMs, baseIntervalMs * 2 ** (attempts - 1));
      if (intervalMs > 0) {
        await delay(intervalMs, signal);
      }
    }
    if (this.terminalSnapshot.status === "successful" && this.terminalSnapshot.result) {
      return this.terminalSnapshot.result;
    }
    throw makeJobFailedError(this.terminalSnapshot);
  }

  /**
   * Translate an OGC `statusInfo` payload onto the canonical snapshot
   * surface, fire watchers, and (for `successful` terminals) fetch the
   * result document inline so the snapshot's `result.outputs` is
   * populated by the time `runUntilTerminal` / `poll` resolves.
   */
  private async handleOgcStatus(ogcStatus: HonuaOgcProcessJobStatus): Promise<JobSnapshot<T>> {
    const status = (ogcStatus.status as JobStatus) ?? "accepted";
    const progress = progressFromOgcStatus(ogcStatus);
    this.currentStatus = status;
    this.currentProgress = progress;
    // Routes the server publishes on this document win over the Core template.
    this.absorbLinks(ogcStatus.links);

    if (status === "successful") {
      try {
        if (this.capabilityPolicy === "strict" && this.resultsPath === undefined) {
          throw capabilityRefusal("processes.jobResultsLink", this.type, {
            construct: "job results route",
            linkRelation: PROCESSES_LINK_REL.results,
          });
        }
        // Per OGC API Processes §7.11.1 the document-mode result body is the
        // outputs map itself (honua-server returns `{}` for the canonical
        // V1 process; populated maps are keyed by output id). Wrap it into
        // the canonical `JobResult.outputs` envelope.
        const results = await this.client.getOgcProcessJobResults(this.jobRequest(this.resultsPath));
        const snapshot: JobSnapshot<T> = {
          status: "successful",
          progress,
          result: { outputs: results as Record<string, T> },
        };
        this.terminalSnapshot = snapshot;
        this.notify(snapshot);
        return snapshot;
      } catch (error) {
        // A fail-closed capability refusal is not a job failure: the job may
        // well have succeeded, the SDK simply refuses to guess the route.
        // Surfacing it as `failed` would launder a client-side refusal into a
        // server-side outcome.
        if (error instanceof HonuaCapabilityNotSupportedError) throw error;
        const failure: JobSnapshot<T> = {
          status: "failed",
          progress,
          error: {
            code: (error as { name?: string } | undefined)?.name ?? "ResultsFetchFailed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        this.currentStatus = "failed";
        this.terminalSnapshot = failure;
        this.notify(failure);
        return failure;
      }
    }

    if (status === "failed" || status === "dismissed") {
      const error = terminalJobError(status, ogcStatus);
      const snapshot: JobSnapshot<T> = {
        status,
        progress,
        ...(error ? { error } : {}),
      };
      this.terminalSnapshot = snapshot;
      this.notify(snapshot);
      return snapshot;
    }

    const snapshot: JobSnapshot<T> = { status, progress };
    this.notify(snapshot);
    return snapshot;
  }

  /**
   * Job-route envelope pinned to the root the job was created against,
   * preferring a route the server advertised over the Core path template.
   */
  private jobRequest(routePath?: string): OgcProcessJobRequest {
    return {
      jobId: this.id,
      ...(this.basePath !== undefined ? { basePath: this.basePath } : {}),
      ...(routePath !== undefined ? { routePath } : {}),
    };
  }

  /**
   * Dismissal is an optional Core extension. When the server's declaration is
   * in hand and neither the Dismiss conformance class nor the process's
   * `jobControlOptions` includes `dismiss`, refuse before issuing a DELETE the
   * server never advertised.
   */
  private assertDismissDeclared(): void {
    // Under `"strict"` the DELETE route must have been advertised, exactly as
    // the status route must be, so dismissal is never sent to a guessed path.
    if (this.capabilityPolicy === "strict" && this.statusPath === undefined) {
      throw capabilityRefusal("processes.jobStatusLink", this.type, {
        construct: "job status route",
        linkRelation: PROCESSES_LINK_REL.status,
      });
    }
    if (declares(this.jobControlOptions, JOB_CONTROL.dismiss)) return;
    const conformsTo = this.conformance?.conformsTo;
    if (!conformsTo) return;
    if (hasOgcConformanceClass(this.conformance, PROCESSES_CONFORMANCE_MATCH.dismiss)) return;
    throw capabilityRefusal("processes.dismiss", this.type, {
      missingClass: PROCESSES_CONFORMANCE.dismiss,
      construct: JOB_CONTROL.dismiss,
    });
  }

  private notify(snapshot: JobSnapshot<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener exceptions must not break the runner; log silently.
      }
    }
  }
}

/**
 * `IJobRun` for a synchronous execution (Core §7.11: `200` with the results
 * document inline). No job resource exists on the server, so the run starts
 * terminal: `results()` resolves from memory, `poll()` replays the terminal
 * snapshot, and `cancel()` is a no-op that reports the outcome that already
 * happened. Callers therefore read a sync and an async execution through one
 * surface.
 */
export class HonuaOgcProcessSyncRun<T = unknown> implements IJobRun<T> {
  /** Empty: OGC Processes assigns no job identifier to a synchronous execution. */
  public readonly id = "";
  public readonly type: string;
  public readonly status: JobStatus = "successful";
  public readonly progress: JobProgress | undefined = { percent: 100 };

  private readonly snapshot: JobSnapshot<T>;

  public constructor(processId: string, outputs: Record<string, T>) {
    this.type = processId;
    this.snapshot = { status: "successful", progress: this.progress, result: { outputs } };
  }

  public async poll(): Promise<JobSnapshot<T>> {
    return this.snapshot;
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    // The only transition already happened; replay it so watchers registered
    // after a synchronous execution still observe the terminal snapshot.
    listener(this.snapshot);
    return () => {};
  }

  public async results(): Promise<JobResult<T>> {
    // Non-null: the constructor always builds a `successful` snapshot with a result.
    return this.snapshot.result as JobResult<T>;
  }

  public async cancel(): Promise<JobStatus> {
    return "successful";
  }
}

/** Error thrown when `IJobRun.results()` resolves a non-success terminal. */
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

/**
 * Honua-server emits problem-details JSON for DELETE /jobs/{id} 409s. The
 * `title` distinguishes the benign terminal race ("Cannot dismiss
 * completed job") from non-benign 409s ("Dismiss could not be confirmed",
 * "Cancellation not supported"). The detail text mirrors the title
 * ("terminal state '...'") so we accept either as confirmation.
 */
function isCompletedJobConflict(error: unknown): boolean {
  const body = (error as { body?: unknown } | undefined)?.body;
  if (!body || typeof body !== "object") return false;
  const title = (body as { title?: unknown }).title;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof title === "string" && /cannot dismiss completed job/i.test(title)) {
    return true;
  }
  if (typeof detail === "string" && /terminal state/i.test(detail)) {
    return true;
  }
  return false;
}

function terminalJobError(status: JobStatus, ogcStatus: HonuaOgcProcessJobStatus): JobError | undefined {
  if (ogcStatus.exception) {
    return { ...ogcStatus.exception };
  }
  // honua-server emits failure text as `statusInfo.message` (its
  // StatusInfo DTO has no `exception` field). Fall back to the progress
  // message so `HonuaJobFailedError.message` carries the server reason
  // instead of the generic "non-success terminal state" default.
  if (typeof ogcStatus.message === "string" && ogcStatus.message.length > 0) {
    return {
      code: status === "dismissed" ? "JobDismissed" : "JobFailed",
      message: ogcStatus.message,
    };
  }
  return undefined;
}

function progressFromOgcStatus(ogcStatus: HonuaOgcProcessJobStatus | undefined): JobProgress | undefined {
  if (!ogcStatus) return undefined;
  const out: JobProgress = {};
  if (typeof ogcStatus.progress === "number" && Number.isFinite(ogcStatus.progress)) {
    out.percent = clampPercent(ogcStatus.progress);
  }
  if (ogcStatus.message !== undefined) out.message = ogcStatus.message;
  if (ogcStatus.updated !== undefined) out.updatedAt = ogcStatus.updated;
  if (out.percent === undefined && out.message === undefined && out.updatedAt === undefined) {
    return undefined;
  }
  return out;
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function makeJobFailedError<T>(snapshot: JobSnapshot<T>): HonuaJobFailedError {
  const error: JobError | undefined = snapshot.error;
  const message = error?.message ?? `Job ended in non-success terminal state: ${snapshot.status}`;
  return new HonuaJobFailedError(message, snapshot.status, error?.code, error?.details);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createHonuaOgcProcesses(client: HonuaClient): HonuaOgcProcesses {
  return new HonuaOgcProcesses({ client });
}

// Type-only re-export so adapter map augmentation in `contract/source.ts`
// can reference the OGC processes runner without importing the full
// surface module.
export type HonuaOgcProcessesAdapter = HonuaOgcProcesses;
export type { OgcProcessStatus };

// ── OGC API Processes wire methods ──────────────────────────────

export async function getOgcProcessesLanding(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcLandingResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcLandingResponse>(
    `ogc-processes:landing:${processesBaseKey(request)}${params.toString()}`,
    `${base}?${params.toString()}`,
    request,
  );
}

export async function getOgcProcessesConformance(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcConformanceResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
    `ogc-processes:conformance:${processesBaseKey(request)}${params.toString()}`,
    `${base}/conformance?${params.toString()}`,
    request,
  );
}

export async function listOgcProcesses(
  transport: HonuaProtocolTransport,
  request: OgcMetadataRequest = {},
): Promise<HonuaOgcProcessesResponse> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcProcessesResponse>(
    `ogc-processes:processes:${processesBaseKey(request)}${params.toString()}`,
    `${base}/processes?${params.toString()}`,
    request,
  );
}

export async function getOgcProcess(
  transport: HonuaProtocolTransport,
  request: { processId: string } & OgcMetadataRequest,
): Promise<HonuaOgcProcessDescription> {
  const params = createOgcMetadataParams(request);
  const base = processesBase(request);
  return transport.requestCachedMetadataJson<HonuaOgcProcessDescription>(
    // Both components are percent-encoded so neither can smuggle the `:`
    // separator and alias a different (basePath, processId) pair.
    `ogc-processes:process:${processesBaseKey(request)}${encodeURIComponent(request.processId)}:${params.toString()}`,
    `${base}/processes/${encodeURIComponent(request.processId)}?${params.toString()}`,
    request,
  );
}

/**
 * `POST /processes/{processId}/execution` (Core §7.11).
 *
 * Core defines two success shapes and a conformant server may choose either:
 * `200` with the results document (synchronous) or `201` + `Location` with a
 * `statusInfo` body (asynchronous). This reads the response rather than
 * assuming one, so the same call works against a raw third-party server and
 * against the async-only Honua facade, and reports which shape came back.
 */
export async function executeOgcProcess(
  transport: HonuaProtocolTransport,
  request: OgcProcessExecuteRequest,
): Promise<HonuaOgcProcessJobAccepted> {
  const headers = mergeHeaders(
    { "Content-Type": "application/json", Accept: "application/json" },
    request.headers,
    preferHeaderForExecute(request),
  );
  const path = `${processesBase(request)}/processes/${encodeURIComponent(request.processId)}/execution`;
  // `document` is the only response mode the SDK decodes: its body is the
  // output-id-keyed map that `JobResult.outputs` is defined over. (honua-server
  // additionally rejects `raw` with HTTP 501.)
  const body = JSON.stringify({
    inputs: request.inputs ?? {},
    outputs: request.outputs,
    response: "document",
  });
  // pipelineFetch over requestJson: Core distinguishes the synchronous and
  // asynchronous outcomes by status code and `Location`, both of which a
  // JSON-only helper discards.
  const response = await transport.pipelineFetch("POST", path, { headers, body }, request.signal);
  const payload = await readExecutionPayload(response);
  const statusInfo = asJobStatusInfo(payload, request.processId);
  const documentUrl = requestUrlFor(transport.baseUrl, path);
  const location = advertisedRoutePath(response.headers.get("Location") ?? undefined, documentUrl, transport.baseUrl);

  if (statusInfo) {
    const statusPath =
      location ?? linkPath(statusInfo.links, documentUrl, transport.baseUrl, PROCESSES_LINK_REL.status, "status");
    return {
      jobID: statusInfo.jobID,
      status: statusInfo.status,
      processID: statusInfo.processID ?? request.processId,
      ...(statusInfo.links ? { links: [...statusInfo.links] } : {}),
      statusInfo,
      ...(statusPath !== undefined ? { statusPath } : {}),
      synchronous: false,
    };
  }

  if (location !== undefined) {
    // `201 Location` with no (or an unrecognized) body: the job exists and the
    // server named its route. Derive the id from the advertised route's last
    // segment rather than inventing one.
    const jobId = jobIdFromRoute(location);
    return {
      jobID: jobId,
      status: "accepted",
      processID: request.processId,
      statusPath: location,
      synchronous: false,
    };
  }

  // No job identifier and no job route: Core leaves only the synchronous shape,
  // whose body IS the results document.
  return {
    jobID: "",
    status: "successful",
    processID: request.processId,
    results: (payload ?? {}) as HonuaOgcProcessJobResults,
    synchronous: true,
  };
}

/**
 * Decode an execution response body. A `204` (or empty body) yields
 * `undefined`; a non-JSON body is refused rather than guessed at, because the
 * SDK asked for `response: "document"` and can only project a JSON outputs map
 * onto `JobResult.outputs`.
 */
async function readExecutionPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw capabilityRefusal("processes.documentResponse", undefined, {
      construct: "document-mode execution response",
      contentType: response.headers.get("Content-Type") ?? "unknown",
    });
  }
}

/** Recognize an async `statusInfo` body: Core requires a non-empty `jobID`. */
function asJobStatusInfo(payload: unknown, processId: string): HonuaOgcProcessJobStatus | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const candidate = payload as Partial<HonuaOgcProcessJobStatus>;
  if (typeof candidate.jobID !== "string" || candidate.jobID.length === 0) return undefined;
  return {
    ...(candidate as HonuaOgcProcessJobStatus),
    jobID: candidate.jobID,
    processID: candidate.processID ?? processId,
    status: candidate.status ?? "accepted",
  };
}

/** Last path segment of an advertised job route, decoded. */
function jobIdFromRoute(routePath: string): string {
  const withoutQuery = routePath.split("?", 1)[0] ?? routePath;
  const trimmed = withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function getOgcProcessJob(
  transport: HonuaProtocolTransport,
  request: OgcProcessJobRequest,
): Promise<HonuaOgcProcessJobStatus> {
  const params = createOgcMetadataParams(request);
  const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}`;
  return transport.requestJson<HonuaOgcProcessJobStatus>("GET", withParams(route, params), undefined, request.signal);
}

export async function getOgcProcessJobResults(
  transport: HonuaProtocolTransport,
  request: OgcProcessJobRequest,
): Promise<HonuaOgcProcessJobResults> {
  const params = createOgcMetadataParams(request);
  const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}/results`;
  return transport.requestJson<HonuaOgcProcessJobResults>("GET", withParams(route, params), undefined, request.signal);
}

export async function cancelOgcProcessJob(
  transport: HonuaProtocolTransport,
  request: OgcProcessJobRequest,
): Promise<HonuaOgcProcessJobStatus> {
  const params = createOgcMetadataParams(request);
  const route = request.routePath ?? `${processesBase(request)}/jobs/${encodeURIComponent(request.jobId)}`;
  return transport.requestJson<HonuaOgcProcessJobStatus>(
    "DELETE",
    withParams(route, params),
    undefined,
    request.signal,
  );
}

/**
 * Build the execution preference header defined by OGC API Processes 1.0.
 * Requirement 25 selects synchronous execution by omitting `Prefer`; only an
 * explicit asynchronous request sends the standard `respond-async` token.
 * Clients remain prepared for either response shape.
 */
function preferHeaderForExecute(request: OgcProcessExecuteRequest): { Prefer: string } | undefined {
  if (request.mode === "async") {
    return { Prefer: "respond-async" };
  }
  return undefined;
}
