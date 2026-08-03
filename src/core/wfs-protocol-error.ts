import { HonuaSdkError } from "./error-envelope.js";

export type WfsProtocolErrorReason =
  | "invalid-capabilities"
  | "invalid-feature-response"
  | "paging-stalled"
  | "unknown-axis-order"
  /** `DescribeFeatureType` did not yield the feature type's geometry property. */
  | "unresolved-geometry-property";

/** Typed, credential-safe fail-closed WFS protocol error. */
export class HonuaWfsProtocolError extends HonuaSdkError {
  public constructor(
    public readonly reason: WfsProtocolErrorReason,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super("query.execution.wfs-protocol", message, {
      context: { reason },
      ...("cause" in options ? { cause: options.cause } : {}),
    });
    this.name = "HonuaWfsProtocolError";
  }
}
