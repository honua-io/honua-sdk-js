import type {
  CrsDefinition,
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  ExtensionIdentifier,
  JsonPrimitive,
  JsonValue,
  SourceProtocol,
  SourceSchemaV2,
} from "../contract/schema.js";

export type FieldName<TRecord> = Extract<keyof TRecord, string>;
type NonNullish<TValue> = Exclude<TValue, null | undefined>;
type Scalar = string | number | boolean | bigint | Date;
type IsUntyped<TValue> = unknown extends TValue ? true : false;

export type ScalarFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends Scalar
      ? TKey
      : never;
}[FieldName<TRecord>];

export type StringFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends TemporalValue
      ? never
      : NonNullish<TRecord[TKey]> extends string
        ? TKey
        : never;
}[FieldName<TRecord>];

export type OrderableFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends string | number | bigint | Date
      ? TKey
      : never;
}[FieldName<TRecord>];

export type NumericFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends number | bigint
      ? TKey
      : never;
}[FieldName<TRecord>];

export type GroupableFieldName<TRecord> = ScalarFieldName<TRecord>;

declare const temporalValueBrand: unique symbol;

/** Schema/role-derived temporal string; an ordinary string does not gain temporal operators. */
export type TemporalValue<TKind extends "date" | "instant" = "date" | "instant"> = string & {
  readonly [temporalValueBrand]: TKind;
};

export type TemporalFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends TemporalValue | Date
      ? TKey
      : never;
}[FieldName<TRecord>];

export type GeometryFieldName<TRecord> = {
  [TKey in FieldName<TRecord>]-?: IsUntyped<NonNullish<TRecord[TKey]>> extends true
    ? TKey
    : NonNullish<TRecord[TKey]> extends ExecutableGeometryValue
      ? TKey
      : never;
}[FieldName<TRecord>];

export type QueryLiteral<TValue> = IsUntyped<NonNullish<TValue>> extends true
  ? JsonValue
  : NonNullish<TValue> extends bigint | Date
    ? string
    : NonNullish<TValue> extends JsonPrimitive
      ? NonNullish<TValue>
      : JsonValue;

export interface PropertyNode<TField extends string = string> {
  readonly kind: "property";
  readonly name: TField;
}

export interface LiteralNode<TValue extends JsonValue = JsonValue> {
  readonly kind: "literal";
  readonly value: TValue;
}

export type EqualityOperator = "eq" | "ne";
export type OrderedComparisonOperator = "lt" | "lte" | "gt" | "gte";

type EqualityNode<TRecord> = {
  [TKey in ScalarFieldName<TRecord>]: {
    readonly kind: "comparison";
    readonly operator: EqualityOperator;
    readonly left: PropertyNode<TKey>;
    readonly right: LiteralNode<QueryLiteral<TRecord[TKey]>>;
  };
}[ScalarFieldName<TRecord>];

type OrderedComparisonNode<TRecord> = {
  [TKey in OrderableFieldName<TRecord>]: {
    readonly kind: "comparison";
    readonly operator: OrderedComparisonOperator;
    readonly left: PropertyNode<TKey>;
    readonly right: LiteralNode<QueryLiteral<TRecord[TKey]>>;
  };
}[OrderableFieldName<TRecord>];

export type ComparisonNode<TRecord> = EqualityNode<TRecord> | OrderedComparisonNode<TRecord>;

type ListNodeForRecord<TRecord> = {
  [TKey in ScalarFieldName<TRecord>]: {
    readonly kind: "list";
    readonly operator: "in";
    readonly operand: PropertyNode<TKey>;
    readonly values: readonly [LiteralNode<QueryLiteral<TRecord[TKey]>>, ...LiteralNode<QueryLiteral<TRecord[TKey]>>[]];
  };
}[ScalarFieldName<TRecord>];

export type ListNode<TRecord> = ListNodeForRecord<TRecord>;

type RangeNodeForRecord<TRecord> = {
  [TKey in OrderableFieldName<TRecord>]: {
    readonly kind: "range";
    readonly operator: "between";
    readonly operand: PropertyNode<TKey>;
    readonly lower: LiteralNode<QueryLiteral<TRecord[TKey]>>;
    readonly upper: LiteralNode<QueryLiteral<TRecord[TKey]>>;
  };
}[OrderableFieldName<TRecord>];

export type RangeNode<TRecord> = RangeNodeForRecord<TRecord>;

export interface NullNode<TField extends string = string> {
  readonly kind: "null";
  readonly operator: "is-null" | "is-not-null";
  readonly operand: PropertyNode<TField>;
}

export interface PatternNode<TField extends string = string> {
  readonly kind: "pattern";
  readonly operator: "like";
  readonly operand: PropertyNode<TField>;
  readonly pattern: string;
  readonly caseSensitive?: boolean;
}

export type TopologicalSpatialPredicate =
  | "equals"
  | "intersects"
  | "within"
  | "contains"
  | "disjoint"
  | "touches"
  | "overlaps"
  | "crosses";
export type DistanceSpatialPredicate = "within-distance" | "beyond-distance";
export type SpatialPredicate = TopologicalSpatialPredicate | "bbox-intersects" | DistanceSpatialPredicate;
export type DistanceUnit =
  | "metre"
  | "kilometre"
  | "foot"
  | "us-survey-foot"
  | "mile"
  | "nautical-mile"
  | "degree"
  | "radian";

export interface DistanceOperand {
  readonly value: number;
  readonly unit: DistanceUnit;
  readonly mode: "planar" | "geodesic";
}

export type SourceSpatiality = "primary-geometry" | "non-spatial" | "ambiguous-geometry";

export type SpatialNode<TRecord, TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? never
  : (
      | {
          readonly kind: "spatial";
          readonly operator: TopologicalSpatialPredicate;
          readonly geometry: ExecutableGeometryValue;
        }
      | {
          readonly kind: "spatial";
          readonly operator: "bbox-intersects";
          readonly bbox: ExecutableBoundingBox;
        }
      | {
          readonly kind: "spatial";
          readonly operator: DistanceSpatialPredicate;
          readonly geometry: ExecutableGeometryValue;
          readonly distance: DistanceOperand;
        }
    ) &
      (TSpatiality extends "primary-geometry"
        ? { readonly property?: PropertyNode<GeometryFieldName<TRecord>> }
        : { readonly property: PropertyNode<GeometryFieldName<TRecord>> });

export type TemporalPredicate = "before" | "after" | "during" | "time-intersects";

export type TemporalLiteralNode =
  | { readonly kind: "temporal-literal"; readonly valueType: "date" | "instant"; readonly value: string }
  | {
      readonly kind: "temporal-literal";
      readonly valueType: "interval";
      readonly value: readonly [string, string];
    };

type TemporalNodeForRecord<TRecord> = {
  [TKey in TemporalFieldName<TRecord>]: {
    readonly kind: "temporal";
    readonly operator: TemporalPredicate;
    readonly operand: PropertyNode<TKey>;
    readonly value: TemporalLiteralNode;
  };
}[TemporalFieldName<TRecord>];

export type TemporalNode<TRecord> = TemporalNodeForRecord<TRecord>;

export type BuiltInNativeDialect =
  | "honua-grpc"
  | "geoservices-sql92"
  | "cql2-json"
  | "cql2-text"
  | "fes-2.0"
  | "odata-4.0"
  | "duckdb-sql";

export type NativeDialectFor<TProtocol extends SourceProtocol> = TProtocol extends "grpc"
  ? "honua-grpc"
  : TProtocol extends "geoservices-feature-service" | "geoservices-map-service" | "geoservices-image-service"
    ? "geoservices-sql92"
    : TProtocol extends "ogc-features" | "ogc-records" | "stac"
      ? "cql2-json" | "cql2-text"
      : TProtocol extends "wfs"
        ? "fes-2.0"
        : TProtocol extends "odata"
          ? "odata-4.0"
          : TProtocol extends "geoparquet"
            ? "duckdb-sql"
            : TProtocol extends ExtensionIdentifier
              ? `${TProtocol}.${string}`
              : never;

export type NativePayloadFor<TDialect extends BuiltInNativeDialect | ExtensionIdentifier> = TDialect extends
  | "cql2-json"
  | "honua-grpc"
  ? { readonly format: "json"; readonly value: JsonValue }
  : TDialect extends "fes-2.0"
    ? { readonly format: "xml"; readonly text: string }
    : TDialect extends "geoservices-sql92" | "cql2-text" | "odata-4.0" | "duckdb-sql"
      ? { readonly format: "text"; readonly text: string }
      : TDialect extends ExtensionIdentifier
        ?
            | { readonly format: "text" | "xml"; readonly text: string }
            | { readonly format: "json"; readonly value: JsonValue }
        : never;

export type NativeFilter<TDialect extends BuiltInNativeDialect | ExtensionIdentifier> = {
  readonly kind: "native";
  readonly dialect: TDialect;
  readonly payload: NativePayloadFor<TDialect>;
};

export type SemanticFilter<TRecord, TSpatiality extends SourceSpatiality> =
  | ComparisonNode<TRecord>
  | ListNode<TRecord>
  | RangeNode<TRecord>
  | NullNode<FieldName<TRecord>>
  | PatternNode<StringFieldName<TRecord>>
  | SpatialNode<TRecord, TSpatiality>
  | TemporalNode<TRecord>
  | {
      readonly kind: "boolean";
      readonly operator: "and" | "or";
      readonly args: readonly [SemanticFilter<TRecord, TSpatiality>, ...SemanticFilter<TRecord, TSpatiality>[]];
    }
  | { readonly kind: "not"; readonly arg: SemanticFilter<TRecord, TSpatiality> };

export type QueryFilter<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> =
  | SemanticFilter<TRecord, TSpatiality>
  | (NativeDialectFor<TProtocol> extends never ? never : NativeFilter<NativeDialectFor<TProtocol>>);

export interface SemanticSort<TRecord> {
  readonly field: OrderableFieldName<TRecord>;
  readonly direction: "asc" | "desc";
  readonly nulls?: "first" | "last" | "native";
}

export type CountMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "count";
  readonly field?: FieldName<TRecord>;
  readonly as: TAlias;
};

export type NumericMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "sum" | "avg" | "stddev" | "variance";
  readonly field: NumericFieldName<TRecord>;
  readonly as: TAlias;
};

export type ExtremumMetric<TRecord, TAlias extends string = string> = {
  readonly fn: "min" | "max";
  readonly field: OrderableFieldName<TRecord>;
  readonly as: TAlias;
};

export type AggregateMetric<TRecord, TAlias extends string = string> =
  | CountMetric<TRecord, TAlias>
  | NumericMetric<TRecord, TAlias>
  | ExtremumMetric<TRecord, TAlias>;

export type GeometryProjectionFor<TRecord, TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? "omit"
  : TSpatiality extends "primary-geometry"
    ? "include" | "omit" | { readonly field: GeometryFieldName<TRecord> }
    : "omit" | { readonly field: GeometryFieldName<TRecord> };

export type OutputCrsFor<TSpatiality extends SourceSpatiality> = TSpatiality extends "non-spatial"
  ? never
  : Exclude<CrsDefinition, { readonly kind: "unknown" }>;

export interface FirstPageRequest {
  readonly kind: "first";
  readonly limit?: number;
}

export interface OffsetPageRequest {
  readonly kind: "offset";
  readonly offset: number;
  readonly limit?: number;
}

/** Continuation values remain runtime-owned and are intentionally outside the S1 JSON AST. */
export type SemanticPageRequest = FirstPageRequest | OffsetPageRequest;

interface SemanticQueryBase<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> {
  readonly filter?: QueryFilter<TRecord, TProtocol, TSpatiality>;
  readonly sort?: readonly SemanticSort<TRecord>[];
  readonly page?: SemanticPageRequest;
  readonly outputCrs?: OutputCrsFor<TSpatiality>;
}

export interface SemanticFeatureQuery<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality,
  TSelect extends readonly FieldName<TRecord>[] | undefined = undefined,
  TGeometry extends GeometryProjectionFor<TRecord, TSpatiality> = GeometryProjectionFor<TRecord, TSpatiality>,
> extends SemanticQueryBase<TRecord, TProtocol, TSpatiality> {
  readonly kind: "features";
  readonly select?: TSelect;
  readonly geometry?: TGeometry;
}

export interface SemanticAggregateQuery<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality,
  TGroupBy extends readonly GroupableFieldName<TRecord>[] = readonly [],
  TMetrics extends readonly [AggregateMetric<TRecord>, ...AggregateMetric<TRecord>[]] = readonly [
    AggregateMetric<TRecord>,
    ...AggregateMetric<TRecord>[],
  ],
> extends SemanticQueryBase<TRecord, TProtocol, TSpatiality> {
  readonly kind: "aggregate";
  readonly groupBy: TGroupBy;
  readonly metrics: TMetrics;
}

export type SemanticQuery<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> =
  | SemanticFeatureQuery<
      TRecord,
      TProtocol,
      TSpatiality,
      readonly FieldName<TRecord>[] | undefined,
      GeometryProjectionFor<TRecord, TSpatiality>
    >
  | SemanticAggregateQuery<
      TRecord,
      TProtocol,
      TSpatiality,
      readonly GroupableFieldName<TRecord>[],
      readonly [AggregateMetric<TRecord>, ...AggregateMetric<TRecord>[]]
    >;

export type SpatialityForSchema<TSchema extends Pick<SourceSchemaV2, "geometry">> = TSchema["geometry"] extends {
  readonly state: "none";
}
  ? "non-spatial"
  : TSchema["geometry"] extends {
        readonly state: "known";
        readonly primaryField: { readonly state: "known" };
      }
    ? "primary-geometry"
    : "ambiguous-geometry";

export interface ParseSemanticQueryOptions {
  /** A verified schema is reparsed before use so JavaScript callers cannot forge schema truth. */
  readonly schema?: SourceSchemaV2;
  /** When present, a native expression must match this source protocol. */
  readonly protocol?: SourceProtocol;
}

/** Identity inputs carried into canonical semantic-query bytes and hashes. */
export interface CanonicalSemanticQueryOptions extends ParseSemanticQueryOptions {
  /** Version/fingerprint of the CRS registry or transform policy used by the caller. */
  readonly crsVersion?: string;
  /** Version/fingerprint of the authorization/capability policy used by the caller. */
  readonly policyVersion?: string;
}

/** External CQL2 filter context that cannot be encoded inside CQL2 JSON itself. */
export interface Cql2JsonInterchangeOptions extends ParseSemanticQueryOptions {
  /**
   * CRS and coordinate order represented by spatial literals. Required when a
   * supported expression contains a geometry or bounding box.
   */
  readonly filterCrs?: ExecutableCrsBinding;
}

/** Strict, supported CQL2 JSON filter expression. */
export type Cql2JsonExpression = Readonly<{
  op: string;
  args: readonly JsonValue[];
}>;

export type LegacyWhereProtocol =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  | "ogc-features"
  | "ogc-records"
  | "stac"
  | "odata"
  | "geoparquet";

export type LegacyWhereDialectFor<TProtocol extends LegacyWhereProtocol> = TProtocol extends
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  ? "geoservices-sql92"
  : TProtocol extends "ogc-features" | "ogc-records" | "stac"
    ? "cql2-text"
    : TProtocol extends "odata"
      ? "odata-4.0"
      : "duckdb-sql";
