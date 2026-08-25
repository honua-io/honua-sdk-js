/**
 * Error taxonomy for {@link HonuaStudioLifecycleClient}.
 *
 * Every non-2xx response from the Studio package lifecycle API
 * (`/api/v{version}/studio`) is either a handler-generated client error
 * (`400`/`401`/`403`/`404`/`409`) or a caught internal failure (`500`), and
 * both use
 * RFC 7807 problem details with `type: "https://honua.io/problems/studio"`
 * (see `docs/internal/admin-api/studio-package-lifecycle.md` in
 * `honua-server`). {@link HonuaStudioError} normalizes both into one typed
 * shape so callers branch on `.code` instead of parsing HTTP status numbers
 * or problem-detail strings.
 *
 * `generation-conflict` is a distinct discriminant (not folded into a
 * generic `"conflict"` bucket) because it is the one Studio failure mode the
 * SDK expects callers to *recover from automatically* — reload the draft and
 * retry — rather than surface to a user. Use
 * {@link isHonuaStudioGenerationConflict} to branch on it without comparing
 * `.code` strings directly.
 *
 * This module intentionally does not join the central `HonuaSdkError`
 * registry (`src/core/error-code-registry.ts`): `studio` is an
 * `@experimental`, not-yet-semver-covered domain, matching the existing
 * `HonuaCollaborationError` (`src/collaboration/errors.ts`) precedent for
 * experimental-domain errors pending a scoped migration.
 *
 * @module
 */

/**
 * Discriminant classifying a {@link HonuaStudioError}. Derived from the HTTP
 * status code of the failed response:
 *
 * - `validation` — `400`, request or envelope failed validation.
 * - `unauthorized` — `401`, the request carried no usable principal.
 * - `forbidden` — `403`, the principal is authenticated but is not permitted
 *   to perform the operation — the owner/tenant scope ceiling, and the
 *   separate-approver rule that stops a proposer from approving their own
 *   publication (see {@link HonuaStudioPublicationRequestsClient}).
 * - `not-found` — `404`, the draft/version/content item does not exist (or,
 *   per the API doc, is not reachable from the given `itemId`/`versionId`
 *   pair — cross-item ids are treated as not found).
 * - `generation-conflict` — `409`, the draft's server-managed `generation`
 *   changed since the caller last read it (`PUT /package-drafts/{draftId}`
 *   optimistic-concurrency check). Reload the draft and retry.
 * - `internal` — `500`, a caught internal failure.
 * - `unknown` — any other status the doc does not enumerate.
 *
 * @experimental
 */
export type HonuaStudioProblemKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "generation-conflict"
  | "internal"
  | "unknown";

/**
 * RFC 7807 problem-details body returned by the Studio package lifecycle API.
 * `type` is `"https://honua.io/problems/studio"` on every documented error
 * response; `code` and `errors` are optional server-supplied extensions.
 *
 * @experimental
 */
export interface HonuaStudioProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code?: string;
  readonly errors?: Record<string, readonly string[]>;
  readonly [extra: string]: unknown;
}

/** Canonical RFC 7807 `type` URI the Studio lifecycle API uses for every problem response. */
export const HONUA_STUDIO_PROBLEM_TYPE = "https://honua.io/problems/studio" as const;

/**
 * Thrown by every {@link HonuaStudioLifecycleClient} method when the server
 * returns a non-2xx response. Carries the raw HTTP `statusCode`, the
 * classified `.code` discriminant (see {@link HonuaStudioProblemKind}), and
 * the parsed RFC 7807 `.problem` body when the response was problem+json.
 *
 * @experimental
 */
export class HonuaStudioError extends Error {
  public readonly code: HonuaStudioProblemKind;
  public readonly statusCode: number;
  public readonly problem: HonuaStudioProblemDetails | undefined;

  public constructor(
    code: HonuaStudioProblemKind,
    statusCode: number,
    message: string,
    problem?: HonuaStudioProblemDetails,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HonuaStudioError";
    this.code = code;
    this.statusCode = statusCode;
    this.problem = problem;
  }
}

/** Type guard for {@link HonuaStudioError}. */
export function isHonuaStudioError(error: unknown): error is HonuaStudioError {
  return error instanceof HonuaStudioError;
}

/**
 * True only for the `409` optimistic-concurrency discriminant — the draft's
 * `generation` changed since the caller last read it. Callers should reload
 * the draft (`drafts.get`) and retry the `PUT` with the fresh `generation`
 * rather than surface this as a hard failure.
 */
export function isHonuaStudioGenerationConflict(error: unknown): error is HonuaStudioError {
  return isHonuaStudioError(error) && error.code === "generation-conflict";
}

/** @internal Classify an HTTP status code into a {@link HonuaStudioProblemKind}. */
export function classifyStudioProblemStatus(statusCode: number): HonuaStudioProblemKind {
  switch (statusCode) {
    case 400:
      return "validation";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "generation-conflict";
    case 500:
      return "internal";
    default:
      return "unknown";
  }
}
