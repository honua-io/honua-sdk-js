/**
 * The declarative interaction vocabulary from the open geospatial MCP
 * standard (geospatial-mcp ADR-0030, `spec/schemas/common/interactions.schema.json`).
 *
 * This module owns ONLY the data shapes, the standard's closed sets, and the
 * pure validation rules — no binding, no DOM, no imports — so the same rules
 * can be reused by the agent-tool vocabulary (`@honua/sdk-js/agent-tools`'
 * `bindInteraction` verb) without dragging the compiler
 * (`./declarative.js`) and its exploration primitives into that bundle.
 *
 * The normative rules encoded here:
 *
 * - **Closed event set** — `featureSelect`/`featureHover` (layer sources),
 *   `selection` (widget sources), `change` (control sources),
 *   `viewportChange` (map source). Extending it requires a standard ADR.
 * - **Closed verb set** — `setFilter`, `setViewport`, `selectFeature`,
 *   `runWidgetQuery`, `setVisibility`. Verbs mutate presentation/exploration
 *   state only, never source records.
 * - **Arguments are static JSON plus `$event.*` path substitution.** There is
 *   no expression language: no arithmetic, no conditionals, no function
 *   calls. A string that starts with `$event` MUST be a well-formed
 *   `$event.<segment>[.<segment>…]` path.
 * - **Unique ids** within one interactions block.
 * - **Fan-out cap** — at most {@link HONUA_INTERACTION_FANOUT_CAP} (8,
 *   the standard's RECOMMENDED cap) interactions may share one
 *   (`on.ref`, `on.event`) pair. Blocks over the cap are rejected, never
 *   truncated.
 *
 * Reference resolution ("does `layer:parcels` exist in this document?") is a
 * validation-gate responsibility the standard deliberately leaves to the
 * host; the compiler in `./declarative.js` performs it against the concrete
 * components it is handed.
 *
 * @module
 */

/** Closed event vocabulary (`$defs/eventName`). */
export const HONUA_INTERACTION_EVENTS = [
  "featureSelect",
  "featureHover",
  "selection",
  "change",
  "viewportChange",
] as const;

export type HonuaInteractionEvent = (typeof HONUA_INTERACTION_EVENTS)[number];

/** Closed action-verb vocabulary (`$defs/actionVerb`). */
export const HONUA_INTERACTION_VERBS = [
  "setFilter",
  "setViewport",
  "selectFeature",
  "runWidgetQuery",
  "setVisibility",
] as const;

export type HonuaInteractionVerb = (typeof HONUA_INTERACTION_VERBS)[number];

/** Component-reference kinds addressable by an interaction (`$defs/componentRef`). */
export const HONUA_INTERACTION_REF_KINDS = ["map", "layer", "widget", "control"] as const;

export type HonuaInteractionRefKind = (typeof HONUA_INTERACTION_REF_KINDS)[number];

/** `map` | `layer:{id}` | `widget:{id}` | `control:{id}`. */
export type HonuaInteractionRef = string;

/**
 * The standard's RECOMMENDED per-(`on.ref`, `on.event`) fan-out cap. A block
 * that exceeds it is rejected whole rather than truncated.
 */
export const HONUA_INTERACTION_FANOUT_CAP = 8;

/** The `$event.` prefix that marks the only dynamic element of an argument value. */
export const HONUA_INTERACTION_EVENT_PATH_PREFIX = "$event.";

/** One declarative event→action binding (`$defs/interaction`). */
export interface HonuaInteraction {
  readonly id: string;
  readonly on: {
    readonly ref: HonuaInteractionRef;
    readonly event: HonuaInteractionEvent;
  };
  readonly do: {
    readonly ref: HonuaInteractionRef;
    readonly verb: HonuaInteractionVerb;
    readonly args?: Readonly<Record<string, unknown>>;
  };
  /** Authored-but-inactive binding; retained in the document, skipped at dispatch. */
  readonly disabled?: boolean;
}

/** One grid placement (`$defs/layoutItem`); presentation metadata only. */
export interface HonuaInteractionLayoutItem {
  readonly ref: HonuaInteractionRef;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The standard's presentation-only `layout` block. */
export interface HonuaInteractionLayout {
  readonly grid?: { readonly columns?: number };
  readonly items?: ReadonlyArray<HonuaInteractionLayoutItem>;
}

/** A parsed component reference. */
export interface HonuaParsedInteractionRef {
  readonly kind: HonuaInteractionRefKind;
  /** Absent only for `kind: "map"`. */
  readonly id?: string;
}

export type HonuaInteractionIssueCode =
  | "invalid-shape"
  | "duplicate-id"
  | "unknown-event"
  | "unknown-verb"
  | "invalid-ref"
  | "invalid-event-path"
  | "fan-out-exceeded";

/** One validation failure. Never carries argument values — only structural detail. */
export interface HonuaInteractionIssue {
  readonly code: HonuaInteractionIssueCode;
  /** The offending interaction's id, when it could be read. */
  readonly interactionId?: string;
  /** Dotted path into the interaction object, e.g. `do.args.value`. */
  readonly path: string;
  readonly message: string;
}

const REF_PATTERN = /^(map|layer:.+|widget:.+|control:.+)$/;
const EVENT_PATH_PATTERN = /^\$event(\.[^.\s]+)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a syntactically valid `map` | `layer:{id}` | `widget:{id}` | `control:{id}` reference. */
export function isHonuaInteractionRef(value: unknown): value is HonuaInteractionRef {
  return typeof value === "string" && REF_PATTERN.test(value);
}

/** Splits a component reference into its kind and id. Returns `undefined` for a malformed reference. */
export function parseHonuaInteractionRef(ref: string): HonuaParsedInteractionRef | undefined {
  if (ref === "map") return { kind: "map" };
  const separator = ref.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  if (id.length === 0) return undefined;
  if (kind !== "layer" && kind !== "widget" && kind !== "control") return undefined;
  return { kind, id };
}

export function isHonuaInteractionEvent(value: unknown): value is HonuaInteractionEvent {
  return typeof value === "string" && (HONUA_INTERACTION_EVENTS as readonly string[]).includes(value);
}

export function isHonuaInteractionVerb(value: unknown): value is HonuaInteractionVerb {
  return typeof value === "string" && (HONUA_INTERACTION_VERBS as readonly string[]).includes(value);
}

/**
 * True when a string value is a `$event.*` substitution path. A string that
 * starts with `$event` but is not a well-formed path (`"$event"`,
 * `"$event."`, `"$eventfoo"`) is NOT a path — it is a validation failure,
 * caught by {@link validateHonuaInteraction}.
 */
export function isHonuaInteractionEventPath(value: string): boolean {
  return EVENT_PATH_PATTERN.test(value);
}

/**
 * Reads the value at a `$event.a.b` path out of an event payload. Returns
 * `undefined` when any segment is missing — there is no error channel and no
 * default, matching the standard's "substitution, not expression" posture.
 */
export function readHonuaInteractionEventPath(payload: unknown, path: string): unknown {
  const segments = path.slice("$event".length).split(".").filter(Boolean);
  let current: unknown = payload;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Substitutes every `$event.*` string in `args` with the value at that path
 * in `payload`, recursing through nested objects and arrays. Non-string
 * values and strings without the prefix are copied through unchanged — this
 * is the whole of the dynamic surface.
 */
export function resolveHonuaInteractionArgs(
  args: Readonly<Record<string, unknown>> | undefined,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  if (!args) return {};
  return substitute(args, payload) as Readonly<Record<string, unknown>>;
}

function substitute(value: unknown, payload: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith(HONUA_INTERACTION_EVENT_PATH_PREFIX)
      ? readHonuaInteractionEventPath(payload, value)
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, payload));
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) next[key] = substitute(child, payload);
    return next;
  }
  return value;
}

/**
 * Validates ONE interaction against the standard's schema-level rules
 * (shape, closed sets, reference grammar, `$event.*` argument discipline).
 * Fan-out and id uniqueness are block-level rules — see
 * {@link validateHonuaInteractions}.
 */
export function validateHonuaInteraction(value: unknown, path = "interaction"): ReadonlyArray<HonuaInteractionIssue> {
  const issues: HonuaInteractionIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "invalid-shape", path, message: "An interaction must be a JSON object." }];
  }
  const interactionId = typeof value.id === "string" ? value.id : undefined;
  const issue = (code: HonuaInteractionIssueCode, field: string, message: string): void => {
    issues.push({ code, ...(interactionId ? { interactionId } : {}), path: `${path}.${field}`, message });
  };

  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 200) {
    issue("invalid-shape", "id", "`id` must be a non-empty string of at most 200 characters.");
  }
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    issue("invalid-shape", "disabled", "`disabled` must be a boolean when present.");
  }

  if (!isRecord(value.on)) {
    issue("invalid-shape", "on", "`on` must be an object with `ref` and `event`.");
  } else {
    if (!isHonuaInteractionRef(value.on.ref)) {
      issue("invalid-ref", "on.ref", "`on.ref` must be `map`, `layer:{id}`, `widget:{id}`, or `control:{id}`.");
    }
    if (!isHonuaInteractionEvent(value.on.event)) {
      issue("unknown-event", "on.event", `\`on.event\` must be one of: ${HONUA_INTERACTION_EVENTS.join(", ")}.`);
    }
    for (const key of Object.keys(value.on)) {
      if (key !== "ref" && key !== "event") {
        issue("invalid-shape", `on.${key}`, "`on` accepts only `ref` and `event`.");
      }
    }
  }

  if (!isRecord(value.do)) {
    issue("invalid-shape", "do", "`do` must be an object with `ref` and `verb`.");
  } else {
    if (!isHonuaInteractionRef(value.do.ref)) {
      issue("invalid-ref", "do.ref", "`do.ref` must be `map`, `layer:{id}`, `widget:{id}`, or `control:{id}`.");
    }
    if (!isHonuaInteractionVerb(value.do.verb)) {
      issue("unknown-verb", "do.verb", `\`do.verb\` must be one of: ${HONUA_INTERACTION_VERBS.join(", ")}.`);
    }
    if (value.do.args !== undefined) {
      if (!isRecord(value.do.args)) {
        issue("invalid-shape", "do.args", "`do.args` must be a JSON object when present.");
      } else {
        collectEventPathIssues(value.do.args, `${path}.do.args`, interactionId, issues);
      }
    }
    for (const key of Object.keys(value.do)) {
      if (key !== "ref" && key !== "verb" && key !== "args") {
        issue("invalid-shape", `do.${key}`, "`do` accepts only `ref`, `verb`, and `args`.");
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "on" && key !== "do" && key !== "disabled") {
      issue("invalid-shape", key, "An interaction accepts only `id`, `on`, `do`, and `disabled`.");
    }
  }

  return issues;
}

function collectEventPathIssues(
  value: unknown,
  path: string,
  interactionId: string | undefined,
  issues: HonuaInteractionIssue[],
): void {
  if (typeof value === "string") {
    if (value.startsWith("$event") && !isHonuaInteractionEventPath(value)) {
      issues.push({
        code: "invalid-event-path",
        ...(interactionId ? { interactionId } : {}),
        path,
        message:
          "A `$event` argument must be a `$event.<path>` substitution — the vocabulary has no expression language.",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectEventPathIssues(entry, `${path}[${index}]`, interactionId, issues));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectEventPathIssues(child, `${path}.${key}`, interactionId, issues);
    }
  }
}

export interface ValidateHonuaInteractionsOptions {
  /** Per-(`on.ref`, `on.event`) fan-out cap. @default 8 (the standard's RECOMMENDED value) */
  readonly fanOutCap?: number;
}

export interface HonuaInteractionValidation {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<HonuaInteractionIssue>;
}

/**
 * Validates a whole `interactions` block: every member's schema-level rules
 * plus the two block-level ones (unique ids, fan-out cap). Disabled
 * interactions are validated like any other — they are retained in the
 * document, only skipped at dispatch — but they do NOT count toward the
 * fan-out cap, which bounds live dispatch work.
 */
export function validateHonuaInteractions(
  interactions: unknown,
  options: ValidateHonuaInteractionsOptions = {},
): HonuaInteractionValidation {
  const cap = options.fanOutCap ?? HONUA_INTERACTION_FANOUT_CAP;
  if (!Array.isArray(interactions)) {
    return {
      ok: false,
      issues: [{ code: "invalid-shape", path: "interactions", message: "`interactions` must be an array." }],
    };
  }

  const issues: HonuaInteractionIssue[] = [];
  const seenIds = new Set<string>();
  const fanOut = new Map<string, number>();

  interactions.forEach((interaction, index) => {
    const path = `interactions[${index}]`;
    issues.push(...validateHonuaInteraction(interaction, path));
    if (!isRecord(interaction)) return;

    const id = typeof interaction.id === "string" ? interaction.id : undefined;
    if (id !== undefined) {
      if (seenIds.has(id)) {
        issues.push({
          code: "duplicate-id",
          interactionId: id,
          path: `${path}.id`,
          message: `Interaction id "${id}" is declared more than once in this block.`,
        });
      }
      seenIds.add(id);
    }

    if (interaction.disabled === true) return;
    const on = isRecord(interaction.on) ? interaction.on : undefined;
    if (!isHonuaInteractionRef(on?.ref) || !isHonuaInteractionEvent(on?.event)) return;
    const key = `${on.ref} ${on.event}`;
    fanOut.set(key, (fanOut.get(key) ?? 0) + 1);
  });

  for (const [key, count] of fanOut) {
    if (count <= cap) continue;
    const [ref, event] = key.split(" ");
    issues.push({
      code: "fan-out-exceeded",
      path: "interactions",
      message: `${count} interactions share (${ref}, ${event}); the fan-out cap is ${cap}. The block is rejected, not truncated.`,
    });
  }

  return { ok: issues.length === 0, issues };
}
