import type { DegradedReason, Query, Result } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaTypedFeature } from "../core/types.js";
import { HonuaPublicationError } from "./errors.js";
import { referencedFields } from "./fields.js";
import type { Publication } from "./open.js";

/** Keeps every query and result of a publication to its public fields. */
export interface PublicFieldGuard {
  readonly names: readonly string[];
  has(name: string): boolean;
  query<Q extends Query<unknown>>(query: Q | undefined): Q;
  result<T>(result: Result<T>, extraDegraded?: DegradedReason): Result<T>;
}

export function publicFieldGuard(publication: Publication, sourceId: string): PublicFieldGuard {
  const names = publication.publicFields.map((field) => field.name);
  const allowed = new Set(names);

  function publicAttributes<T>(attributes: unknown): T {
    const source = (attributes ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name))) as T;
  }

  return Object.freeze({
    names,
    has: (name: string) => allowed.has(name),
    query<Q extends Query<unknown>>(query: Q | undefined): Q {
      const request = { ...(query ?? {}) } as Q;
      if (request.where !== undefined) {
        throw new HonuaCapabilityNotSupportedError("where", "geoparquet", sourceId, {
          context: { reason: "a publication accepts typed filters only, so every field it names can be checked" },
        });
      }
      for (const name of referencedFields(request)) {
        if (!allowed.has(name)) {
          throw new HonuaPublicationError(
            "non-public-field",
            `${name} is not a public field of ${publication.descriptor.publicationId}.`,
            { detail: { field: name } },
          );
        }
      }
      return request.outFields && request.outFields.length > 0 ? request : { ...request, outFields: names };
    },
    result<T>(result: Result<T>, extraDegraded?: DegradedReason): Result<T> {
      const features = result.features.map(
        (feature): HonuaTypedFeature<T> => ({ ...feature, attributes: publicAttributes<T>(feature.attributes) }),
      );
      const degraded = [...(result.degraded ?? []), ...(extraDegraded ? [extraDegraded] : [])];
      return {
        ...result,
        features,
        ...(result.fields ? { fields: result.fields.filter((field) => allowed.has(field.name)) } : {}),
        ...(degraded.length > 0 ? { degraded } : {}),
      };
    },
  });
}
