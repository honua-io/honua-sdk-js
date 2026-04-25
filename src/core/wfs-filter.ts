/**
 * FES 2.0 Filter Encoding emitter for the WFS adapter. Two responsibilities:
 *
 * - Compile the canonical `Query.where` SQL-92-ish expression into a small
 *   FES AST. The supported subset is documented in `docs/wfs.md` —
 *   comparison operators, `IN`, `BETWEEN`, `LIKE`, `IS NULL`, boolean
 *   combinators, parenthesization, and string / number literals. Anything
 *   richer (subqueries, function calls, vendor extensions) yields the
 *   sentinel `"unsupported"` so the caller throws
 *   `HonuaCapabilityNotSupportedError("query")` rather than ship a
 *   silent partial filter.
 *
 * - Translate `Query.spatialFilter` into a spatial FES predicate. Only the
 *   simple geometries the canonical surface emits are supported — envelope,
 *   point, polygon, polyline. Curves and surfaces are out of scope; callers
 *   that need them reach the wire through `Source.protocol("wfs")`.
 *
 * The emitter never reaches `fetch`; it returns plain strings the adapter
 * splices into the URL (KVP `filter=`) or the POST body (`<fes:Filter>`).
 *
 * @module
 */

import type { SpatialFilter } from "./spatial-filter.js";

/**
 * Sentinel used by the `where` compiler when the input contains a construct
 * the FES emitter does not know how to translate. Callers should treat this
 * as "fail the query" rather than "emit a partial filter".
 */
export const UNSUPPORTED_FES = "unsupported" as const;

export type FesCompileResult = FesNode | typeof UNSUPPORTED_FES;

export type FesNode =
  | { kind: "and"; operands: readonly FesNode[] }
  | { kind: "or"; operands: readonly FesNode[] }
  | { kind: "not"; operand: FesNode }
  | { kind: "compare"; op: FesCompareOp; property: string; value: FesLiteral }
  | { kind: "between"; property: string; lower: FesLiteral; upper: FesLiteral }
  | { kind: "in"; property: string; values: readonly FesLiteral[] }
  | { kind: "like"; property: string; pattern: string }
  | { kind: "isNull"; property: string }
  | { kind: "spatial"; op: FesSpatialOp; property: string; gml: string }
  | {
      kind: "bbox";
      property: string;
      envelope: { xmin: number; ymin: number; xmax: number; ymax: number; srsName?: string };
    };

export type FesCompareOp = "=" | "<>" | "<" | "<=" | ">" | ">=";
export type FesSpatialOp =
  | "Intersects"
  | "Within"
  | "Contains"
  | "Crosses"
  | "Disjoint"
  | "Touches"
  | "Overlaps"
  | "Equals";
export type FesLiteral = { kind: "string"; value: string } | { kind: "number"; value: number };

/**
 * Compile a `Query.where` SQL-92 string into FES AST. Returns
 * `UNSUPPORTED_FES` for inputs the emitter cannot translate; the adapter
 * promotes this to `HonuaCapabilityNotSupportedError("query")`.
 */
export function compileWhere(input: string | undefined): FesCompileResult {
  if (input === undefined) return { kind: "and", operands: [] };
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === "1=1") return { kind: "and", operands: [] };
  const tokens = tokenize(trimmed);
  if (!tokens) return UNSUPPORTED_FES;
  const parser = new Parser(tokens);
  try {
    const node = parser.parseExpression();
    if (!parser.atEnd()) return UNSUPPORTED_FES;
    return node;
  } catch {
    return UNSUPPORTED_FES;
  }
}

/**
 * Compile the canonical `SpatialFilter` (Esri-flavored) into the FES spatial
 * leaf the adapter splices into the request. Default geometry property
 * name is `the_geom`; callers may override (some servers use `geometry`,
 * `shape`, etc.).
 */
export function compileSpatialFilter(
  filter: SpatialFilter,
  options: { geometryProperty: string; srsName?: string },
): FesCompileResult {
  const property = options.geometryProperty;
  const srsName = options.srsName;
  const op = mapSpatialRel(filter.spatialRel);
  if (filter.geometryType === "esriGeometryEnvelope") {
    const env = filter.geometry as { xmin?: number; ymin?: number; xmax?: number; ymax?: number };
    if (
      typeof env.xmin !== "number" ||
      typeof env.ymin !== "number" ||
      typeof env.xmax !== "number" ||
      typeof env.ymax !== "number"
    ) {
      return UNSUPPORTED_FES;
    }
    // <fes:BBOX> is envelope-intersects only. For any other relation the
    // adapter must lower the envelope to a polygon and emit the requested
    // FES spatial op explicitly so non-intersects relations preserve their
    // semantics.
    if (op === "Intersects") {
      const envelope: { xmin: number; ymin: number; xmax: number; ymax: number; srsName?: string } = {
        xmin: env.xmin,
        ymin: env.ymin,
        xmax: env.xmax,
        ymax: env.ymax,
      };
      if (srsName) envelope.srsName = srsName;
      return { kind: "bbox", property, envelope };
    }
    if (!op) return UNSUPPORTED_FES;
    const gml = envelopeToPolygonGml(env.xmin, env.ymin, env.xmax, env.ymax, srsName);
    return { kind: "spatial", op, property, gml };
  }
  if (!op) return UNSUPPORTED_FES;
  const gml = geometryToGml(filter.geometry, filter.geometryType, srsName);
  if (gml === undefined) return UNSUPPORTED_FES;
  return { kind: "spatial", op, property, gml };
}

function envelopeToPolygonGml(
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  srsName: string | undefined,
): string {
  const srsAttr = srsName ? ` srsName=${attr(srsName)}` : "";
  const ring = `${xmin} ${ymin} ${xmax} ${ymin} ${xmax} ${ymax} ${xmin} ${ymax} ${xmin} ${ymin}`;
  return `<gml:Polygon${srsAttr}><gml:exterior><gml:LinearRing><gml:posList>${ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
}

function mapSpatialRel(rel: SpatialFilter["spatialRel"]): FesSpatialOp | undefined {
  switch (rel) {
    case undefined:
    case "esriSpatialRelIntersects":
    case "esriSpatialRelEnvelopeIntersects":
      return "Intersects";
    case "esriSpatialRelContains":
      return "Contains";
    case "esriSpatialRelWithin":
      return "Within";
    case "esriSpatialRelCrosses":
      return "Crosses";
    case "esriSpatialRelOverlaps":
      return "Overlaps";
    case "esriSpatialRelTouches":
      return "Touches";
    default:
      return undefined;
  }
}

/**
 * Serialize a list of FES nodes into a single `<fes:Filter>` element. Used
 * for both the POST GetFeature body and (URL-encoded) the KVP `filter=`
 * query parameter.
 *
 * The FES namespace prefix is always `fes` and is bound on the root
 * `<fes:Filter>` element so the result is self-contained.
 */
export function serializeFes(nodes: readonly FesNode[], options?: { typeName?: string }): string {
  const inner =
    nodes.length === 0
      ? ""
      : nodes.length === 1
        ? serializeNode(nodes[0])
        : serializeNode({ kind: "and", operands: nodes });
  const typeNameAttr = options?.typeName ? ` typeNames=${attr(options.typeName)}` : "";
  return `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"${typeNameAttr}>${inner}</fes:Filter>`;
}

function serializeNode(node: FesNode): string {
  switch (node.kind) {
    case "and":
      if (node.operands.length === 0) return "";
      if (node.operands.length === 1) return serializeNode(node.operands[0]);
      return `<fes:And>${node.operands.map(serializeNode).join("")}</fes:And>`;
    case "or":
      if (node.operands.length === 1) return serializeNode(node.operands[0]);
      return `<fes:Or>${node.operands.map(serializeNode).join("")}</fes:Or>`;
    case "not":
      return `<fes:Not>${serializeNode(node.operand)}</fes:Not>`;
    case "compare":
      return `<fes:${compareOpElement(node.op)}><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference><fes:Literal>${literalText(node.value)}</fes:Literal></fes:${compareOpElement(node.op)}>`;
    case "between":
      return `<fes:PropertyIsBetween><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference><fes:LowerBoundary><fes:Literal>${literalText(node.lower)}</fes:Literal></fes:LowerBoundary><fes:UpperBoundary><fes:Literal>${literalText(node.upper)}</fes:Literal></fes:UpperBoundary></fes:PropertyIsBetween>`;
    case "in": {
      if (node.values.length === 0)
        return `<fes:PropertyIsEqualTo><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference><fes:Literal>${literalText({ kind: "string", value: "__honua_empty_in__" })}</fes:Literal></fes:PropertyIsEqualTo>`;
      const parts = node.values.map(
        (v) =>
          `<fes:PropertyIsEqualTo><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference><fes:Literal>${literalText(v)}</fes:Literal></fes:PropertyIsEqualTo>`,
      );
      if (parts.length === 1) return parts[0];
      return `<fes:Or>${parts.join("")}</fes:Or>`;
    }
    case "like":
      return `<fes:PropertyIsLike wildCard="%" singleChar="_" escapeChar="\\"><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference><fes:Literal>${escapeXml(node.pattern)}</fes:Literal></fes:PropertyIsLike>`;
    case "isNull":
      return `<fes:PropertyIsNull><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference></fes:PropertyIsNull>`;
    case "spatial":
      return `<fes:${node.op}><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference>${node.gml}</fes:${node.op}>`;
    case "bbox":
      return `<fes:BBOX><fes:ValueReference>${escapeXml(node.property)}</fes:ValueReference>${envelopeGml(node.envelope)}</fes:BBOX>`;
  }
}

function compareOpElement(op: FesCompareOp): string {
  switch (op) {
    case "=":
      return "PropertyIsEqualTo";
    case "<>":
      return "PropertyIsNotEqualTo";
    case "<":
      return "PropertyIsLessThan";
    case "<=":
      return "PropertyIsLessThanOrEqualTo";
    case ">":
      return "PropertyIsGreaterThan";
    case ">=":
      return "PropertyIsGreaterThanOrEqualTo";
  }
}

function literalText(value: FesLiteral): string {
  return value.kind === "number" ? String(value.value) : escapeXml(value.value);
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function attr(value: string): string {
  return `"${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`;
}

function envelopeGml(env: { xmin: number; ymin: number; xmax: number; ymax: number; srsName?: string }): string {
  const srsAttr = env.srsName ? ` srsName=${attr(env.srsName)}` : "";
  return `<gml:Envelope${srsAttr}><gml:lowerCorner>${env.xmin} ${env.ymin}</gml:lowerCorner><gml:upperCorner>${env.xmax} ${env.ymax}</gml:upperCorner></gml:Envelope>`;
}

/**
 * Translate a GeoJSON-style geometry into a tiny GML 3.2 fragment. Only the
 * primitive shapes the canonical surface emits are supported (point, line,
 * polygon). Curves and surfaces return `undefined`; callers promote that to
 * `UNSUPPORTED_FES`.
 */
function geometryToGml(
  geometry: Record<string, unknown>,
  geometryType: SpatialFilter["geometryType"],
  srsName: string | undefined,
): string | undefined {
  const srsAttr = srsName ? ` srsName=${attr(srsName)}` : "";
  switch (geometryType) {
    case "esriGeometryPoint": {
      const x = (geometry as { x?: unknown }).x;
      const y = (geometry as { y?: unknown }).y;
      if (typeof x !== "number" || typeof y !== "number") return undefined;
      return `<gml:Point${srsAttr}><gml:pos>${x} ${y}</gml:pos></gml:Point>`;
    }
    case "esriGeometryPolyline": {
      const paths = (geometry as { paths?: unknown }).paths;
      if (!Array.isArray(paths) || paths.length === 0) return undefined;
      // Honua emits a single line; downstream curves are out of scope.
      const path = paths[0];
      if (!Array.isArray(path)) return undefined;
      const coords = path
        .map((p) => (Array.isArray(p) ? `${p[0]} ${p[1]}` : ""))
        .filter(Boolean)
        .join(" ");
      if (!coords) return undefined;
      return `<gml:LineString${srsAttr}><gml:posList>${coords}</gml:posList></gml:LineString>`;
    }
    case "esriGeometryPolygon": {
      const rings = (geometry as { rings?: unknown }).rings;
      if (!Array.isArray(rings) || rings.length === 0) return undefined;
      const exterior = ringToPosList(rings[0]);
      if (!exterior) return undefined;
      const interiors: string[] = [];
      for (let i = 1; i < rings.length; i += 1) {
        const inner = ringToPosList(rings[i]);
        if (!inner) return undefined;
        interiors.push(
          `<gml:interior><gml:LinearRing><gml:posList>${inner}</gml:posList></gml:LinearRing></gml:interior>`,
        );
      }
      return `<gml:Polygon${srsAttr}><gml:exterior><gml:LinearRing><gml:posList>${exterior}</gml:posList></gml:LinearRing></gml:exterior>${interiors.join("")}</gml:Polygon>`;
    }
    default:
      return undefined;
  }
}

function ringToPosList(ring: unknown): string | undefined {
  if (!Array.isArray(ring) || ring.length < 3) return undefined;
  return ring
    .map((p) => (Array.isArray(p) ? `${p[0]} ${p[1]}` : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Convert a canonical `CanonicalFeature.geometry` (GeoJSON) into a GML 3.2
 * fragment for `<wfs:Insert>` / `<wfs:Update>` payloads.
 */
export function geoJsonGeometryToGml(geometry: unknown, srsName: string | undefined): string | undefined {
  if (typeof geometry !== "object" || geometry === null) return undefined;
  const geom = geometry as { type?: unknown; coordinates?: unknown };
  const srsAttr = srsName ? ` srsName=${attr(srsName)}` : "";
  switch (geom.type) {
    case "Point": {
      const c = geom.coordinates as [number, number] | undefined;
      if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return undefined;
      return `<gml:Point${srsAttr}><gml:pos>${c[0]} ${c[1]}</gml:pos></gml:Point>`;
    }
    case "LineString": {
      const c = geom.coordinates as Array<[number, number]> | undefined;
      if (!Array.isArray(c) || c.length === 0) return undefined;
      const posList = c.map((p) => `${p[0]} ${p[1]}`).join(" ");
      return `<gml:LineString${srsAttr}><gml:posList>${posList}</gml:posList></gml:LineString>`;
    }
    case "Polygon": {
      const c = geom.coordinates as Array<Array<[number, number]>> | undefined;
      if (!Array.isArray(c) || c.length === 0) return undefined;
      const exterior = c[0].map((p) => `${p[0]} ${p[1]}`).join(" ");
      const interiors = c
        .slice(1)
        .map(
          (ring) =>
            `<gml:interior><gml:LinearRing><gml:posList>${ring.map((p) => `${p[0]} ${p[1]}`).join(" ")}</gml:posList></gml:LinearRing></gml:interior>`,
        )
        .join("");
      return `<gml:Polygon${srsAttr}><gml:exterior><gml:LinearRing><gml:posList>${exterior}</gml:posList></gml:LinearRing></gml:exterior>${interiors}</gml:Polygon>`;
    }
    default:
      return undefined;
  }
}

// ── Parser ────────────────────────────────────────────────────

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function tokenize(input: string): Token[] | undefined {
  const tokens: Token[] = [];
  const len = input.length;
  let i = 0;
  while (i < len) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i += 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < len) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += input[j];
        j += 1;
      }
      if (j >= len) return undefined;
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < len && /[0-9.]/.test(input[j])) j += 1;
      const numText = input.slice(i, j);
      const n = Number(numText);
      if (!Number.isFinite(n)) return undefined;
      tokens.push({ kind: "number", value: n });
      i = j;
      continue;
    }
    if (ch === "<" || ch === ">") {
      const next = input[i + 1];
      if (next === "=" || (ch === "<" && next === ">")) {
        tokens.push({ kind: "op", value: ch + next });
        i += 2;
        continue;
      }
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === "=" || ch === "!") {
      if (ch === "!" && input[i + 1] === "=") {
        tokens.push({ kind: "op", value: "<>" });
        i += 2;
        continue;
      }
      if (ch === "=") {
        tokens.push({ kind: "op", value: "=" });
        i += 1;
        continue;
      }
      return undefined;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_.]/.test(input[j])) j += 1;
      const value = input.slice(i, j);
      tokens.push({ kind: "ident", value });
      i = j;
      continue;
    }
    return undefined;
  }
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  public constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  public parseExpression(): FesNode {
    return this.parseOr();
  }

  private parseOr(): FesNode {
    let left = this.parseAnd();
    while (this.matchKeyword("OR")) {
      const right = this.parseAnd();
      left = combine("or", left, right);
    }
    return left;
  }

  private parseAnd(): FesNode {
    let left = this.parseNot();
    while (this.matchKeyword("AND")) {
      const right = this.parseNot();
      left = combine("and", left, right);
    }
    return left;
  }

  private parseNot(): FesNode {
    if (this.matchKeyword("NOT")) {
      return { kind: "not", operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FesNode {
    const token = this.peek();
    if (!token) throw new Error("unexpected end of expression");
    if (token.kind === "lparen") {
      this.pos += 1;
      const expr = this.parseExpression();
      this.expect("rparen");
      return expr;
    }
    if (token.kind === "ident") {
      const property = token.value;
      this.pos += 1;
      // IS NULL / IS NOT NULL
      if (this.matchKeyword("IS")) {
        const negate = this.matchKeyword("NOT");
        if (!this.matchKeyword("NULL")) throw new Error("expected NULL");
        const node: FesNode = { kind: "isNull", property };
        return negate ? { kind: "not", operand: node } : node;
      }
      // BETWEEN
      if (this.matchKeyword("BETWEEN")) {
        const lower = this.parseLiteral();
        if (!this.matchKeyword("AND")) throw new Error("expected AND in BETWEEN");
        const upper = this.parseLiteral();
        return { kind: "between", property, lower, upper };
      }
      // NOT BETWEEN / NOT IN / NOT LIKE
      if (this.matchKeyword("NOT")) {
        if (this.matchKeyword("BETWEEN")) {
          const lower = this.parseLiteral();
          if (!this.matchKeyword("AND")) throw new Error("expected AND in BETWEEN");
          const upper = this.parseLiteral();
          return { kind: "not", operand: { kind: "between", property, lower, upper } };
        }
        if (this.matchKeyword("IN")) {
          return { kind: "not", operand: this.parseInList(property) };
        }
        if (this.matchKeyword("LIKE")) {
          const pattern = this.parseStringLiteral();
          return { kind: "not", operand: { kind: "like", property, pattern } };
        }
        throw new Error("unsupported NOT clause");
      }
      // IN
      if (this.matchKeyword("IN")) {
        return this.parseInList(property);
      }
      // LIKE
      if (this.matchKeyword("LIKE")) {
        const pattern = this.parseStringLiteral();
        return { kind: "like", property, pattern };
      }
      // Comparison
      const opTok = this.peek();
      if (opTok && opTok.kind === "op") {
        this.pos += 1;
        const value = this.parseLiteral();
        const op = opTok.value as FesCompareOp;
        if (op !== "=" && op !== "<>" && op !== "<" && op !== "<=" && op !== ">" && op !== ">=") {
          throw new Error(`unsupported operator ${op}`);
        }
        return { kind: "compare", op, property, value };
      }
      throw new Error(`unexpected token after identifier "${property}"`);
    }
    throw new Error(`unexpected token ${token.kind}`);
  }

  private parseInList(property: string): FesNode {
    this.expect("lparen");
    const values: FesLiteral[] = [];
    while (true) {
      const tok = this.peek();
      if (!tok) throw new Error("unterminated IN list");
      if (tok.kind === "rparen") {
        this.pos += 1;
        break;
      }
      values.push(this.parseLiteral());
      const next = this.peek();
      if (next?.kind === "comma") {
        this.pos += 1;
        continue;
      }
      if (next?.kind === "rparen") {
        this.pos += 1;
        break;
      }
      throw new Error("expected , or ) in IN list");
    }
    return { kind: "in", property, values };
  }

  private parseLiteral(): FesLiteral {
    const tok = this.peek();
    if (!tok) throw new Error("expected literal");
    if (tok.kind === "string") {
      this.pos += 1;
      return { kind: "string", value: tok.value };
    }
    if (tok.kind === "number") {
      this.pos += 1;
      return { kind: "number", value: tok.value };
    }
    throw new Error(`expected literal, got ${tok.kind}`);
  }

  private parseStringLiteral(): string {
    const tok = this.peek();
    if (!tok || tok.kind !== "string") throw new Error("expected string literal");
    this.pos += 1;
    return tok.value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expect(kind: "lparen" | "rparen"): void {
    const tok = this.peek();
    if (!tok || tok.kind !== kind) throw new Error(`expected ${kind}`);
    this.pos += 1;
  }

  private matchKeyword(keyword: string): boolean {
    const tok = this.peek();
    if (tok && tok.kind === "ident" && tok.value.toUpperCase() === keyword) {
      this.pos += 1;
      return true;
    }
    return false;
  }
}

function combine(kind: "and" | "or", left: FesNode, right: FesNode): FesNode {
  const merged: FesNode[] = [];
  pushOperand(merged, kind, left);
  pushOperand(merged, kind, right);
  return { kind, operands: merged };
}

function pushOperand(target: FesNode[], kind: "and" | "or", node: FesNode): void {
  if (node.kind === kind) {
    for (const op of node.operands) target.push(op);
    return;
  }
  target.push(node);
}
