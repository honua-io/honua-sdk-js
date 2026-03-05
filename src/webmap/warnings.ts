/**
 * Warning collector for WebMap JSON parsing.
 *
 * Collects non-fatal issues encountered during conversion, such as
 * unsupported renderer types, unresolvable URLs, or unrecognized properties.
 *
 * @module
 */

export interface WebMapWarning {
  /** Machine-readable warning code (e.g. `"unsupported-renderer"`). */
  code: string;
  /** JSON-path-like location within the input (e.g. `"operationalLayers[2].layerDefinition.drawingInfo.renderer"`). */
  path: string;
  /** Human-readable description. */
  message: string;
  /** Optional additional context. */
  context?: Record<string, unknown>;
}

export interface WarningCollector {
  /** Emit a warning at the current path scope. */
  warn(code: string, message: string, context?: Record<string, unknown>): void;
  /** Create a child collector with an appended path segment. */
  child(segment: string): WarningCollector;
  /** All warnings collected so far (shared across parent/child). */
  readonly warnings: WebMapWarning[];
}

/** Warn for object properties that are not in the known-property set. */
export function warnUnknownProperties(
  input: Record<string, unknown> | undefined,
  knownProperties: readonly string[],
  warn: WarningCollector,
): void {
  if (!input) return;
  const known = new Set(knownProperties);
  for (const property of Object.keys(input)) {
    if (!known.has(property)) {
      warn.warn("unknown-property", `Property '${property}' is not supported and will be ignored`, { property });
    }
  }
}

export function createWarningCollector(basePath = ""): WarningCollector {
  const warnings: WebMapWarning[] = [];

  function createScoped(path: string): WarningCollector {
    return {
      warn(code: string, message: string, context?: Record<string, unknown>) {
        warnings.push({ code, path, message, ...(context ? { context } : {}) });
      },
      child(segment: string) {
        const childPath = path ? `${path}.${segment}` : segment;
        return createScoped(childPath);
      },
      get warnings() {
        return warnings;
      },
    };
  }

  return createScoped(basePath);
}
