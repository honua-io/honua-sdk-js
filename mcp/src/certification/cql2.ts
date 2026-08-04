/**
 * Minimal CQL2-text evaluator for the offline OGC API Features fixture (#1005).
 *
 * The neutral tool contract lowers `Query.filter` onto CQL2 text for the OGC
 * family, so an offline fixture that ignored `filter=` would certify a filter
 * path that never actually filtered. This evaluator parses the exact subset the
 * SDK's CQL2 compiler emits — comparisons, `IN`, `BETWEEN`, `IS [NOT] NULL`,
 * `LIKE`/`CASEI`, `AND`/`OR`/`NOT`, parentheses, and `DATE()`/`TIMESTAMP()`
 * literals — and REFUSES anything else rather than silently matching every row,
 * which would turn a filter regression into a passing test.
 *
 * It is a fixture, not a CQL2 implementation: spatial predicates are out of
 * scope here (the fixture serves spatial constraints through the `bbox`
 * parameter, exactly as OGC API Features Part 1 defines).
 */

export class Cql2UnsupportedError extends Error {
  constructor(message: string) {
    super(`cql2 fixture: ${message}`);
    this.name = "Cql2UnsupportedError";
  }
}

type Token = { kind: "ident" | "number" | "string" | "symbol" | "keyword"; value: string };

const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "IS", "NULL", "BETWEEN", "LIKE", "TRUE", "FALSE", "CASEI"]);

/** Temporal predicates the fixture evaluates exactly. */
const TEMPORAL_FUNCTIONS = new Set(["T_BEFORE", "T_AFTER", "T_DURING", "T_INTERSECTS"]);

/**
 * Spatial predicates. OGC API Features Part 1 expresses a spatial constraint
 * through the `bbox` parameter, which this fixture serves exactly; the Part 3
 * `S_*` predicates are refused rather than approximated, because a spatial
 * predicate that silently matched the wrong rows would be worse than an error.
 */
const SPATIAL_FUNCTIONS = new Set([
  "S_INTERSECTS",
  "S_CONTAINS",
  "S_WITHIN",
  "S_CROSSES",
  "S_TOUCHES",
  "S_OVERLAPS",
  "S_DISJOINT",
  "S_EQUALS",
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i += 1;
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: "string", value });
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "symbol", value: ch });
      i += 1;
      continue;
    }
    const twoChar = input.slice(i, i + 2);
    if (twoChar === "<=" || twoChar === ">=" || twoChar === "<>") {
      tokens.push({ kind: "symbol", value: twoChar });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") {
      tokens.push({ kind: "symbol", value: ch });
      i += 1;
      continue;
    }
    const numberMatch = /^-?\d+(?:\.\d+)?/.exec(input.slice(i));
    if (numberMatch && /[-\d]/.test(ch)) {
      tokens.push({ kind: "number", value: numberMatch[0] });
      i += numberMatch[0].length;
      continue;
    }
    const identMatch = /^[A-Za-z_][A-Za-z0-9_.:]*/.exec(input.slice(i));
    if (identMatch) {
      const upper = identMatch[0].toUpperCase();
      tokens.push({
        kind: KEYWORDS.has(upper) ? "keyword" : "ident",
        value: KEYWORDS.has(upper) ? upper : identMatch[0],
      });
      i += identMatch[0].length;
      continue;
    }
    throw new Cql2UnsupportedError(`unexpected character "${ch}" in ${JSON.stringify(input)}`);
  }
  return tokens;
}

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Cql2UnsupportedError("unexpected end of expression");
    this.index += 1;
    return token;
  }

  private accept(kind: Token["kind"], value: string): boolean {
    const token = this.peek();
    if (token && token.kind === kind && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expect(kind: Token["kind"], value: string): void {
    if (!this.accept(kind, value)) {
      throw new Cql2UnsupportedError(`expected "${value}" but found ${JSON.stringify(this.peek()?.value ?? "<end>")}`);
    }
  }

  parse(): Predicate {
    const predicate = this.parseOr();
    if (this.index !== this.tokens.length) {
      throw new Cql2UnsupportedError(`trailing input at ${JSON.stringify(this.peek()?.value)}`);
    }
    return predicate;
  }

  private parseOr(): Predicate {
    let left = this.parseAnd();
    while (this.accept("keyword", "OR")) {
      const right = this.parseAnd();
      const previous = left;
      left = (row) => previous(row) || right(row);
    }
    return left;
  }

  private parseAnd(): Predicate {
    let left = this.parseFactor();
    while (this.accept("keyword", "AND")) {
      const right = this.parseFactor();
      const previous = left;
      left = (row) => previous(row) && right(row);
    }
    return left;
  }

  private parseFactor(): Predicate {
    if (this.accept("keyword", "NOT")) {
      const inner = this.parseFactor();
      return (row) => !inner(row);
    }
    if (this.accept("symbol", "(")) {
      const inner = this.parseOr();
      this.expect("symbol", ")");
      return inner;
    }
    const upcoming = this.peek();
    if (upcoming?.kind === "ident") {
      const name = upcoming.value.toUpperCase();
      if (SPATIAL_FUNCTIONS.has(name)) {
        throw new Cql2UnsupportedError(
          `spatial predicate ${name} requires OGC API Features Part 3 filtering, which this endpoint does not publish. Use bbox for an envelope-intersects constraint.`,
        );
      }
      if (TEMPORAL_FUNCTIONS.has(name)) {
        return this.parseTemporal(name);
      }
    }
    return this.parsePredicate();
  }

  /** `T_BEFORE(field, TIMESTAMP('…'))` / `T_DURING(field, INTERVAL('…','…'))`. */
  private parseTemporal(name: string): Predicate {
    this.next();
    this.expect("symbol", "(");
    const property = this.next();
    if (property.kind !== "ident") {
      throw new Cql2UnsupportedError(`${name} expects a property reference, found ${JSON.stringify(property.value)}`);
    }
    this.expect("symbol", ",");
    const bound = this.parseTemporalOperand();
    this.expect("symbol", ")");
    const field = property.value;
    return (row) => {
      const raw = row[field];
      if (typeof raw !== "string") return false;
      const value = Date.parse(raw);
      if (Number.isNaN(value)) return false;
      switch (name) {
        case "T_BEFORE":
          return value < bound.start;
        case "T_AFTER":
          return value > bound.end;
        case "T_DURING":
          return value >= bound.start && value <= bound.end;
        default:
          return value >= bound.start && value <= bound.end;
      }
    };
  }

  private parseTemporalOperand(): { start: number; end: number } {
    const token = this.next();
    if (token.kind !== "ident") {
      throw new Cql2UnsupportedError(`expected a temporal literal, found ${JSON.stringify(token.value)}`);
    }
    const name = token.value.toUpperCase();
    this.expect("symbol", "(");
    if (name === "INTERVAL") {
      const start = this.next();
      this.expect("symbol", ",");
      const end = this.next();
      this.expect("symbol", ")");
      return { start: Date.parse(start.value), end: Date.parse(end.value) };
    }
    if (name === "DATE" || name === "TIMESTAMP") {
      const instant = this.next();
      this.expect("symbol", ")");
      const parsed = Date.parse(instant.value);
      return { start: parsed, end: parsed };
    }
    throw new Cql2UnsupportedError(`unsupported temporal literal "${name}"`);
  }

  /** `CASEI(x)` wraps either a property reference or a literal. */
  private parseOperand(): { property?: string; literal?: unknown; caseInsensitive: boolean } {
    if (this.accept("keyword", "CASEI")) {
      this.expect("symbol", "(");
      const inner = this.parseOperand();
      this.expect("symbol", ")");
      return { ...inner, caseInsensitive: true };
    }
    const token = this.next();
    if (token.kind === "ident") {
      // Temporal literals arrive as DATE('…') / TIMESTAMP('…').
      if ((token.value === "DATE" || token.value === "TIMESTAMP") && this.accept("symbol", "(")) {
        const literal = this.next();
        this.expect("symbol", ")");
        return { literal: literal.value, caseInsensitive: false };
      }
      return { property: token.value, caseInsensitive: false };
    }
    if (token.kind === "string") return { literal: token.value, caseInsensitive: false };
    if (token.kind === "number") return { literal: Number(token.value), caseInsensitive: false };
    if (token.kind === "keyword" && (token.value === "TRUE" || token.value === "FALSE")) {
      return { literal: token.value === "TRUE", caseInsensitive: false };
    }
    if (token.kind === "keyword" && token.value === "NULL") return { literal: null, caseInsensitive: false };
    throw new Cql2UnsupportedError(`unsupported operand ${JSON.stringify(token.value)}`);
  }

  private parsePredicate(): Predicate {
    const left = this.parseOperand();
    const read = (row: Row): unknown => (left.property !== undefined ? row[left.property] : left.literal);

    if (this.accept("keyword", "IS")) {
      const negated = this.accept("keyword", "NOT");
      this.expect("keyword", "NULL");
      return (row) => {
        const value = read(row);
        const isNull = value === null || value === undefined;
        return negated ? !isNull : isNull;
      };
    }

    if (this.accept("keyword", "IN")) {
      this.expect("symbol", "(");
      const values: unknown[] = [];
      do {
        values.push(this.parseOperand().literal);
      } while (this.accept("symbol", ","));
      this.expect("symbol", ")");
      return (row) => values.some((candidate) => looseEquals(read(row), candidate));
    }

    if (this.accept("keyword", "BETWEEN")) {
      const lower = this.parseOperand().literal;
      this.expect("keyword", "AND");
      const upper = this.parseOperand().literal;
      return (row) => {
        const value = read(row);
        return compare(value, lower) >= 0 && compare(value, upper) <= 0;
      };
    }

    if (this.accept("keyword", "LIKE")) {
      const right = this.parseOperand();
      const caseInsensitive = left.caseInsensitive || right.caseInsensitive;
      const pattern = likeToRegExp(String(right.literal ?? ""), caseInsensitive);
      return (row) => {
        const value = read(row);
        return value !== null && value !== undefined && pattern.test(String(value));
      };
    }

    const operatorToken = this.next();
    if (operatorToken.kind !== "symbol") {
      throw new Cql2UnsupportedError(`expected a comparison operator, found ${JSON.stringify(operatorToken.value)}`);
    }
    const right = this.parseOperand();
    const rightValue = (row: Row): unknown => (right.property !== undefined ? row[right.property] : right.literal);
    const operator = operatorToken.value;
    return (row) => {
      const a = read(row);
      const b = rightValue(row);
      if (a === null || a === undefined || b === null || b === undefined) {
        return operator === "<>" ? a !== b : false;
      }
      switch (operator) {
        case "=":
          return looseEquals(a, b);
        case "<>":
          return !looseEquals(a, b);
        case "<":
          return compare(a, b) < 0;
        case "<=":
          return compare(a, b) <= 0;
        case ">":
          return compare(a, b) > 0;
        case ">=":
          return compare(a, b) >= 0;
        default:
          throw new Cql2UnsupportedError(`unsupported operator "${operator}"`);
      }
    };
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const as = String(a);
  const bs = String(b);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]");
  return new RegExp(`^${translated}$`, caseInsensitive ? "i" : "");
}

/** Compile a CQL2-text expression into a row predicate. */
export function compileCql2(filter: string): Predicate {
  return new Parser(tokenize(filter)).parse();
}
