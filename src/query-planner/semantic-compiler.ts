import {
  type CrsDefinition,
  type ExecutableCrsBinding,
  type JsonPrimitive,
  type LogicalField,
  type SourceProtocol,
  type SourceSchemaV2,
  parseSourceSchemaV2,
} from "../contract/schema.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import type { SemanticQuery, SourceSpatiality } from "./semantic-types.js";
import { parseSemanticQuery } from "./semantic.js";
import { HonuaQueryPlanningError } from "./types.js";

/** Fidelity attached to a successful semantic compiler result. */
export type SemanticCompilerFidelity = "exact" | "approximate";

/** Stable reasons a valid semantic query cannot be represented by a compiler. */
export type SemanticCompilerUnsupportedCode =
  | "unsupported-crs"
  | "crs-transform-required"
  | "unsupported-distance"
  | "unsupported-field-type"
  | "unsupported-geometry"
  | "unsupported-native-filter"
  | "unsupported-node"
  | "unsupported-projection"
  | "unsupported-sort"
  | "unsupported-source";

/** Path-addressed, deterministic unsupported outcome. */
export interface SemanticCompilerDiagnostic {
  readonly code: SemanticCompilerUnsupportedCode;
  readonly path: string;
  readonly message: string;
}

/** Stable fidelity loss carried beside an approximate compiled artifact. */
export interface SemanticCompilerLoss {
  readonly code: "spatial-envelope-reduction";
  readonly path: string;
  readonly message: string;
}

/**
 * A compiler never silently drops a node. Valid but non-representable queries
 * produce an explicit unsupported result; malformed queries still throw the
 * common planning error before an artifact can be constructed.
 */
export type SemanticCompilationResult<TArtifact> =
  | {
      readonly outcome: "compiled";
      readonly fidelity: SemanticCompilerFidelity;
      readonly losses: readonly SemanticCompilerLoss[];
      readonly artifact: TArtifact;
    }
  | {
      readonly outcome: "unsupported";
      readonly fidelity: "unsupported";
      readonly diagnostics: readonly [SemanticCompilerDiagnostic, ...SemanticCompilerDiagnostic[]];
    };

/** Ordered bind value for parameterized semantic SQL. */
export interface SemanticSqlParameter {
  /** One-based position matching the corresponding `?` in SQL text. */
  readonly position: number;
  readonly role: "literal" | "geometry" | "bbox" | "distance";
  readonly value: JsonPrimitive;
  readonly field?: string;
  readonly logicalType?: string;
}

export type RuntimeSemanticQuery<TProtocol extends SourceProtocol> = SemanticQuery<
  Record<string, unknown>,
  TProtocol,
  SourceSpatiality
>;

interface SemanticCompilerBuild<TArtifact> {
  readonly artifact: TArtifact;
  readonly losses?: readonly SemanticCompilerLoss[];
}

class SemanticCompilerUnsupported extends Error {
  public constructor(public readonly diagnostic: SemanticCompilerDiagnostic) {
    super(diagnostic.message);
    this.name = "SemanticCompilerUnsupported";
  }
}

/** @internal Verify untrusted schema/query values once at the compiler boundary. */
export function prepareSemanticCompilerQuery<TProtocol extends SourceProtocol>(
  value: unknown,
  schemaValue: SourceSchemaV2,
  protocol: TProtocol,
): { readonly query: RuntimeSemanticQuery<TProtocol>; readonly schema: SourceSchemaV2 } {
  let schema: SourceSchemaV2;
  try {
    schema = parseSourceSchemaV2(schemaValue);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic compilation requires a valid SourceSchemaV2");
  }
  const query = parseSemanticQuery(value, { schema, protocol }) as RuntimeSemanticQuery<TProtocol>;
  return { query, schema };
}

/** @internal Convert compiler-local unsupported failures into the public union. */
export function runSemanticCompiler<TArtifact>(
  compile: () => SemanticCompilerBuild<TArtifact>,
): SemanticCompilationResult<TArtifact> {
  try {
    const built = compile();
    const losses = [...(built.losses ?? [])];
    return deepFreeze({
      outcome: "compiled",
      fidelity: losses.length === 0 ? "exact" : "approximate",
      losses,
      artifact: built.artifact,
    });
  } catch (error) {
    if (!(error instanceof SemanticCompilerUnsupported)) throw error;
    return deepFreeze({
      outcome: "unsupported",
      fidelity: "unsupported",
      diagnostics: [error.diagnostic],
    });
  }
}

/** @internal Stop compilation at an exact query path without constructing a request. */
export function semanticUnsupported(code: SemanticCompilerUnsupportedCode, path: string, message: string): never {
  throw new SemanticCompilerUnsupported({ code, path, message });
}

/** @internal Resolve one validated logical field. */
export function semanticSchemaField(schema: SourceSchemaV2, name: string, path: string): LogicalField {
  const field = schema.fields.find((candidate) => candidate.name === name);
  if (!field) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `${path} references unknown schema field ${JSON.stringify(name)}`,
    );
  }
  return field;
}

/** @internal Compare executable CRS semantics without volatile provenance. */
export function sameExecutableCrs(left: ExecutableCrsBinding, right: ExecutableCrsBinding): boolean {
  return crsBindingIdentity(left) === crsBindingIdentity(right);
}

/** @internal Compare a requested output definition with a field binding. */
export function sameCrsDefinition(left: CrsDefinition, right: CrsDefinition): boolean {
  return canonicalStringify(toJsonValue(left)) === canonicalStringify(toJsonValue(right));
}

function crsBindingIdentity(binding: ExecutableCrsBinding): string {
  return canonicalStringify(
    toJsonValue({
      definition: binding.definition,
      coordinateOrder: binding.coordinateOrder,
      coordinateEpoch: binding.coordinateEpoch ?? null,
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
