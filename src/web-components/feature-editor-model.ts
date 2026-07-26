/**
 * DOM-free presentation model behind `<honua-feature-editor>` — the
 * production-tier capability-aware editing surface (issue #680, parent epic
 * #678).
 *
 * Everything here is a *derivation* over the public contract editing
 * primitives (`EditWorkflowField` / `EditFieldDomain` /
 * `EditWorkflowCapabilitySummary` / `EditWorkflowValidationResult` from
 * `@honua/sdk-js/contract`) plus the public source descriptor. No protocol
 * adapter is imported, no service field name is hard-coded, and no transport
 * happens: this module turns metadata into renderable controls, turns raw
 * control input back into typed attribute values, and answers "which
 * operations are truthfully available right now, and why not".
 *
 * Three things the protocol layer deliberately does not model, derived here
 * because they are presentation concerns:
 *
 * 1. **Coded-value / range domains from native schema.** The contract's
 *    `resolveEditWorkflowMetadata` carries `name`/`type`/`length`/`nullable`/
 *    `editable`/`defaultValue` across from `SourceSchema.fields` but not the
 *    native `domain` block. {@link editorFieldsFromSchema} closes that gap
 *    over a structural (adapter-free) field shape so the contract's own
 *    `validate()` rejects out-of-domain values *before* transport.
 * 2. **Subtypes.** There is no subtype primitive in the contract. A subtype is
 *    modeled here as a coded-value domain on one field plus per-subtype field
 *    overrides ({@link HonuaEditorSubtypeConfig}); {@link resolveEditorFields}
 *    folds the active subtype's overrides into the field list handed to the
 *    edit session, so switching subtype changes the valid choices *and* what
 *    the contract validator accepts.
 * 3. **Per-operation availability.** The contract exposes one coarse
 *    `applyEdits` capability. {@link resolveEditorOperations} splits it into
 *    truthful per-operation state, folding in the capability profile's
 *    `authorization-required` / `authorization-denied` / `policy-disabled`
 *    verdicts, structural facts (an update or delete needs a feature
 *    identity), and host-supplied per-operation denials. It only ever
 *    *narrows* — a host override can never grant an operation the source does
 *    not support (fail closed).
 *
 * @module
 */

import type {
  EditFieldDomain,
  EditFieldDomainCodedValue,
  EditWorkflowCapabilitySummary,
  EditWorkflowField,
  EditWorkflowValidationError,
  EditWorkflowValidationResult,
} from "../contract/edit-session.js";

// ── schema → edit fields ─────────────────────────────────────────────────

/**
 * Structural shape of one public schema field (`SourceSchema.fields[n]`, i.e.
 * `HonuaFieldInfo`), described structurally so this module carries no import
 * from any protocol-specific surface.
 */
export interface HonuaEditorSchemaFieldLike {
  readonly name: string;
  readonly type?: string;
  readonly alias?: string;
  readonly length?: number;
  readonly nullable?: boolean;
  readonly editable?: boolean;
  readonly defaultValue?: unknown;
  readonly domain?: HonuaEditorSchemaDomainLike | null;
}

/** Structural shape of a native field domain block (coded-value or range). */
export interface HonuaEditorSchemaDomainLike {
  readonly type?: string;
  readonly name?: string;
  readonly codedValues?: readonly { readonly name?: string; readonly code: string | number }[];
  readonly range?: readonly [string | number, string | number];
}

/**
 * Projects public schema fields onto contract {@link EditWorkflowField}s,
 * including the coded-value / range domain the contract's own schema
 * projection drops. Feed the result to `createEditSession`/
 * `createEditSketchWorkflow` as `metadata.fields` so domain violations fail
 * validation before any transport happens (REQ-001).
 */
export function editorFieldsFromSchema(
  fields: readonly HonuaEditorSchemaFieldLike[] | undefined,
): readonly EditWorkflowField[] {
  return (fields ?? []).map((field) => {
    const domain = editorDomainFromSchema(field.domain);
    return {
      name: field.name,
      ...(field.type !== undefined ? { type: field.type } : {}),
      ...(field.alias !== undefined ? { alias: field.alias } : {}),
      ...(field.length !== undefined ? { length: field.length } : {}),
      ...(field.nullable !== undefined ? { nullable: field.nullable } : {}),
      ...(field.editable !== undefined ? { editable: field.editable } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(domain ? { domain } : {}),
    };
  });
}

/** Normalizes a native domain block to the contract's {@link EditFieldDomain}. */
export function editorDomainFromSchema(
  domain: HonuaEditorSchemaDomainLike | null | undefined,
): EditFieldDomain | undefined {
  if (!domain) return undefined;
  const type = (domain.type ?? "").toLowerCase();
  if (type === "codedvalue" || type === "coded-value" || type === "coded_value" || domain.codedValues) {
    const codedValues = (domain.codedValues ?? []).map(
      (coded): EditFieldDomainCodedValue => ({ name: coded.name ?? String(coded.code), code: coded.code }),
    );
    if (codedValues.length === 0) return undefined;
    return { type: "coded-value", ...(domain.name ? { name: domain.name } : {}), codedValues };
  }
  if (type === "range" || domain.range) {
    const min = Number(domain.range?.[0]);
    const max = Number(domain.range?.[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
    return { type: "range", ...(domain.name ? { name: domain.name } : {}), range: [min, max] };
  }
  return undefined;
}

// ── subtypes ─────────────────────────────────────────────────────────────

/** Per-subtype override for one field. `domain: null` clears an inherited domain. */
export interface HonuaEditorSubtypeFieldOverride {
  readonly domain?: EditFieldDomain | null;
  readonly required?: boolean;
  readonly editable?: boolean;
  readonly defaultValue?: unknown;
  /** Hidden fields are not rendered and are never treated as required. */
  readonly hidden?: boolean;
}

/** One subtype: a coded value of the subtype field plus its field overrides. */
export interface HonuaEditorSubtype {
  readonly code: string | number;
  readonly name: string;
  readonly fieldOverrides?: Readonly<Record<string, HonuaEditorSubtypeFieldOverride>>;
}

/**
 * Subtype configuration for an editable source: which field carries the
 * subtype code, the available subtypes, and the code a new feature starts on.
 */
export interface HonuaEditorSubtypeConfig {
  /** Field whose value selects the subtype. */
  readonly field: string;
  readonly subtypes: readonly HonuaEditorSubtype[];
  /** Code applied to a fresh create draft when the field has no value. */
  readonly defaultCode?: string | number;
}

/** The subtype in effect for a set of attribute values, if any. */
export function resolveActiveEditorSubtype(
  config: HonuaEditorSubtypeConfig | undefined,
  values: Readonly<Record<string, unknown>>,
): HonuaEditorSubtype | undefined {
  if (!config) return undefined;
  const raw = values[config.field];
  const code = raw === undefined || raw === null || raw === "" ? config.defaultCode : raw;
  if (code === undefined) return undefined;
  return config.subtypes.find((subtype) => sameCode(subtype.code, code));
}

/**
 * Folds subtype state into the field list handed to the edit session: the
 * subtype field gains a coded-value domain built from the configured
 * subtypes, and the active subtype's per-field overrides (domain, required,
 * editable, default, hidden) are applied on top of the base metadata.
 *
 * Because the result is what `createEditSession`'s `metadata.fields` receives,
 * a subtype change immediately changes both the rendered choices and what the
 * contract validator accepts — an invalid combination is rejected before
 * transport (REQ-001).
 */
export function resolveEditorFields(
  fields: readonly EditWorkflowField[],
  config: HonuaEditorSubtypeConfig | undefined,
  values: Readonly<Record<string, unknown>>,
): readonly EditWorkflowField[] {
  if (!config) return fields;
  const active = resolveActiveEditorSubtype(config, values);
  const subtypeDomain: EditFieldDomain = {
    type: "coded-value",
    codedValues: config.subtypes.map((subtype) => ({ name: subtype.name, code: subtype.code })),
  };
  const known = new Set(fields.map((field) => field.name));
  const resolved = fields.map((field) => {
    const base: EditWorkflowField =
      field.name === config.field ? { ...field, domain: subtypeDomain, required: true } : { ...field };
    return applySubtypeOverride(base, active?.fieldOverrides?.[field.name]);
  });
  // A subtype field absent from the source schema still needs a control and a
  // domain, otherwise a create draft could never pick a subtype at all.
  if (!known.has(config.field)) {
    resolved.unshift(
      applySubtypeOverride(
        { name: config.field, type: subtypeCodeType(config), domain: subtypeDomain, required: true },
        active?.fieldOverrides?.[config.field],
      ),
    );
  }
  return resolved;
}

function applySubtypeOverride(
  field: EditWorkflowField,
  override: HonuaEditorSubtypeFieldOverride | undefined,
): EditWorkflowField {
  if (!override) return field;
  const next: EditWorkflowField = { ...field };
  if (override.domain === null) delete next.domain;
  else if (override.domain !== undefined) next.domain = override.domain;
  if (override.editable !== undefined) next.editable = override.editable;
  if (override.defaultValue !== undefined) next.defaultValue = override.defaultValue;
  if (override.hidden === true) {
    next.required = false;
    next.nullable = true;
  } else if (override.required !== undefined) {
    next.required = override.required;
  }
  return next;
}

function subtypeCodeType(config: HonuaEditorSubtypeConfig): string {
  return config.subtypes.every((subtype) => typeof subtype.code === "number") ? "integer" : "string";
}

/** Field names the active subtype hides from the form. */
export function hiddenEditorFieldNames(
  config: HonuaEditorSubtypeConfig | undefined,
  values: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const active = resolveActiveEditorSubtype(config, values);
  const hidden = new Set<string>();
  for (const [name, override] of Object.entries(active?.fieldOverrides ?? {})) {
    if (override.hidden === true) hidden.add(name);
  }
  return hidden;
}

// ── per-operation availability ───────────────────────────────────────────

/** The three feature-edit operations the editor gates independently. */
export type HonuaEditorOperation = "create" | "update" | "delete";

/** Stable, testable reason code for an unavailable operation. */
export type HonuaEditorUnavailableCode =
  | "capability-unsupported"
  | "capability-unknown"
  | "authorization-required"
  | "authorization-denied"
  | "policy-disabled"
  | "peer-unavailable"
  | "host-denied"
  | "no-feature-identity"
  | "no-editable-fields";

/** Truthful state of one operation, with a reason whenever it is unavailable. */
export interface HonuaEditorOperationAvailability {
  readonly operation: HonuaEditorOperation;
  readonly available: boolean;
  readonly code?: HonuaEditorUnavailableCode;
  readonly reason?: string;
}

/** Host-supplied per-operation denial (e.g. an `updateEnabled: false` service flag). */
export type HonuaEditorOperationOverride = boolean | { readonly available: boolean; readonly reason?: string };

/** Per-operation host overrides. Overrides can only deny, never grant. */
export type HonuaEditorOperationOverrides = Partial<Record<HonuaEditorOperation, HonuaEditorOperationOverride>>;

/**
 * Structural subset of a capability decision (`CapabilityProfile.entries[n]`),
 * described structurally so this module stays free of the capability
 * evaluation surface.
 */
export interface HonuaEditorCapabilityDecisionLike {
  readonly id: string;
  readonly effective: string;
  readonly reasons?: readonly string[];
}

export interface ResolveEditorOperationsInput {
  /** Coarse capability summary from the edit session (`session.capabilities()`). */
  readonly capabilities: Pick<EditWorkflowCapabilitySummary, "applyEdits">;
  /** `source.capabilityProfile?.entries`, when the source carries one. */
  readonly decisions?: readonly HonuaEditorCapabilityDecisionLike[];
  /** Whether the current draft/selection has a feature identity. */
  readonly hasFeatureIdentity: boolean;
  /** Effective (subtype-resolved) field list; used for the read-only check. */
  readonly fields?: readonly EditWorkflowField[];
  readonly overrides?: HonuaEditorOperationOverrides;
}

const EDITOR_OPERATIONS: readonly HonuaEditorOperation[] = ["create", "update", "delete"];

/**
 * Derives truthful per-operation availability. Precedence, most authoritative
 * first: capability profile verdict → coarse `applyEdits` capability → host
 * override → structural preconditions. Every layer can only deny.
 */
export function resolveEditorOperations(
  input: ResolveEditorOperationsInput,
): readonly HonuaEditorOperationAvailability[] {
  const gate = capabilityGate(input);
  return EDITOR_OPERATIONS.map((operation) => {
    if (gate) return { operation, available: false, ...gate };
    const override = normalizeOverride(input.overrides?.[operation]);
    if (override && !override.available) {
      return {
        operation,
        available: false,
        code: "host-denied" as const,
        reason: override.reason ?? `The host disabled ${operation} for this source.`,
      };
    }
    if (operation !== "create" && !input.hasFeatureIdentity) {
      return {
        operation,
        available: false,
        code: "no-feature-identity" as const,
        reason: `Select a feature with an identity to ${operation} it.`,
      };
    }
    if (operation !== "delete" && input.fields && input.fields.length > 0 && !hasEditableField(input.fields)) {
      return {
        operation,
        available: false,
        code: "no-editable-fields" as const,
        reason: "Every field in this source is read-only.",
      };
    }
    return { operation, available: true };
  });
}

function capabilityGate(
  input: ResolveEditorOperationsInput,
): { code: HonuaEditorUnavailableCode; reason: string } | undefined {
  const decision = input.decisions?.find((entry) => entry.id === "applyEdits");
  if (decision && decision.effective !== "supported") {
    const code = UNAVAILABLE_BY_EFFECTIVE[decision.effective] ?? "capability-unknown";
    const detail = decision.reasons && decision.reasons.length > 0 ? ` (${decision.reasons.join(", ")})` : "";
    return { code, reason: `${EFFECTIVE_MESSAGE[code]}${detail}` };
  }
  if (input.capabilities.applyEdits !== "supported") {
    return { code: "capability-unsupported", reason: EFFECTIVE_MESSAGE["capability-unsupported"] };
  }
  return undefined;
}

const UNAVAILABLE_BY_EFFECTIVE: Readonly<Record<string, HonuaEditorUnavailableCode>> = {
  unsupported: "capability-unsupported",
  unknown: "capability-unknown",
  "policy-disabled": "policy-disabled",
  "peer-unavailable": "peer-unavailable",
  "authorization-required": "authorization-required",
  "authorization-denied": "authorization-denied",
};

const EFFECTIVE_MESSAGE: Readonly<Record<HonuaEditorUnavailableCode, string>> = {
  "capability-unsupported": "This source does not support editing.",
  "capability-unknown": "Editing support for this source could not be established.",
  "authorization-required": "Sign in with edit permission to edit this source.",
  "authorization-denied": "Your account is not permitted to edit this source.",
  "policy-disabled": "Editing is disabled for this source by policy.",
  "peer-unavailable": "The service that applies edits is unavailable.",
  "host-denied": "The host disabled this operation.",
  "no-feature-identity": "Select a feature with an identity first.",
  "no-editable-fields": "Every field in this source is read-only.",
};

function normalizeOverride(
  override: HonuaEditorOperationOverride | undefined,
): { available: boolean; reason?: string } | undefined {
  if (override === undefined) return undefined;
  if (typeof override === "boolean") return { available: override };
  return { available: override.available, ...(override.reason ? { reason: override.reason } : {}) };
}

function hasEditableField(fields: readonly EditWorkflowField[]): boolean {
  return fields.some((field) => field.editable !== false);
}

/** Looks one operation's availability up out of a resolved list. */
export function editorOperationAvailability(
  availability: readonly HonuaEditorOperationAvailability[],
  operation: HonuaEditorOperation,
): HonuaEditorOperationAvailability {
  return (
    availability.find((entry) => entry.operation === operation) ?? {
      operation,
      available: false,
      code: "capability-unknown",
      reason: EFFECTIVE_MESSAGE["capability-unknown"],
    }
  );
}

// ── form model ───────────────────────────────────────────────────────────

/** Control type the editor renders for a field. */
export type HonuaEditorControlKind = "text" | "textarea" | "number" | "select" | "checkbox" | "date" | "datetime";

/** One selectable choice of a coded-value domain (or the subtype field). */
export interface HonuaEditorChoice {
  /** Stringified code, as an `<option value>` carries it. */
  readonly value: string;
  readonly label: string;
}

/** One rendered form control, fully derived from field metadata. */
export interface HonuaEditorFieldControl {
  readonly name: string;
  readonly label: string;
  readonly kind: HonuaEditorControlKind;
  readonly value: unknown;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly nullable: boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly HonuaEditorChoice[];
  /** True for the control that drives the active subtype. */
  readonly subtypeField: boolean;
  /** Validation messages scoped to this field. */
  readonly errors: readonly string[];
}

/** The derived form: controls, subtype state, and validation state. */
export interface HonuaEditorFormModel {
  readonly operation: HonuaEditorOperation;
  readonly controls: readonly HonuaEditorFieldControl[];
  readonly valid: boolean;
  /** Validation errors not attributable to a rendered control. */
  readonly formErrors: readonly string[];
  readonly errors: readonly EditWorkflowValidationError[];
  readonly subtype?: {
    readonly field: string;
    readonly code: string | number | undefined;
    readonly name?: string;
    readonly choices: readonly HonuaEditorChoice[];
  };
}

export interface BuildEditorFormModelInput {
  readonly operation: HonuaEditorOperation;
  /** Subtype-resolved field list (see {@link resolveEditorFields}). */
  readonly fields: readonly EditWorkflowField[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly validation: EditWorkflowValidationResult;
  readonly subtypes?: HonuaEditorSubtypeConfig;
}

/**
 * Builds the renderable form from resolved field metadata plus the contract's
 * own validation result — no service field names, no protocol branching
 * (REQ-001).
 */
export function buildEditorFormModel(input: BuildEditorFormModelInput): HonuaEditorFormModel {
  const hidden = hiddenEditorFieldNames(input.subtypes, input.values);
  const errorsByField = new Map<string, string[]>();
  const formErrors: string[] = [];
  for (const error of input.validation.errors) {
    if (error.fieldName === undefined) {
      formErrors.push(error.message);
      continue;
    }
    const bucket = errorsByField.get(error.fieldName) ?? [];
    bucket.push(error.message);
    errorsByField.set(error.fieldName, bucket);
  }

  const controls = input.fields
    .filter((field) => !hidden.has(field.name))
    .map((field) =>
      buildControl(field, input, errorsByField.get(field.name) ?? [], field.name === input.subtypes?.field),
    );

  // Field-scoped errors for hidden fields would otherwise be invisible.
  for (const [name, messages] of errorsByField) {
    if (hidden.has(name)) formErrors.push(...messages);
  }

  const active = resolveActiveEditorSubtype(input.subtypes, input.values);
  return {
    operation: input.operation,
    controls,
    valid: input.validation.valid,
    formErrors,
    errors: input.validation.errors,
    ...(input.subtypes
      ? {
          subtype: {
            field: input.subtypes.field,
            code: active?.code ?? subtypeCodeOf(input.values[input.subtypes.field]),
            ...(active?.name ? { name: active.name } : {}),
            choices: input.subtypes.subtypes.map((subtype) => ({
              value: String(subtype.code),
              label: subtype.name,
            })),
          },
        }
      : {}),
  };
}

function buildControl(
  field: EditWorkflowField,
  input: BuildEditorFormModelInput,
  errors: readonly string[],
  subtypeField: boolean,
): HonuaEditorFieldControl {
  const kind = editorControlKind(field);
  const raw = input.values[field.name];
  const value = raw === undefined ? field.defaultValue : raw;
  // A server-assigned field is read-only in the form, but on a create draft
  // the contract deliberately does not *require* it — mirror that here so the
  // form never demands a value the service supplies.
  const serverAssignedOnCreate = input.operation === "create" && field.editable === false;
  const range = field.domain?.type === "range" ? field.domain.range : undefined;
  return {
    name: field.name,
    label: field.alias ?? field.name,
    kind,
    value: value ?? null,
    required: (field.required === true || field.nullable === false) && !serverAssignedOnCreate,
    readOnly: field.editable === false || input.operation === "delete",
    nullable: field.nullable !== false,
    ...(typeof field.length === "number" && kind !== "number" ? { maxLength: field.length } : {}),
    ...(range ? { min: range[0], max: range[1] } : {}),
    ...(kind === "select" ? { choices: editorChoices(field) } : {}),
    subtypeField,
    errors,
  };
}

/** Control kind for a field: coded-value domains select, otherwise by type. */
export function editorControlKind(field: EditWorkflowField): HonuaEditorControlKind {
  if (field.domain?.type === "coded-value" && (field.domain.codedValues?.length ?? 0) > 0) return "select";
  const type = (field.type ?? "").toLowerCase();
  if (type.includes("bool")) return "checkbox";
  if (type.includes("datetime") || type.includes("timestamp")) return "datetime";
  if (type.includes("date")) return "date";
  if (
    type.includes("int") ||
    type.includes("double") ||
    type.includes("single") ||
    type.includes("float") ||
    type.includes("decimal") ||
    type.includes("number") ||
    field.domain?.type === "range"
  ) {
    return "number";
  }
  if (typeof field.length === "number" && field.length > 255) return "textarea";
  return "text";
}

function editorChoices(field: EditWorkflowField): readonly HonuaEditorChoice[] {
  return (field.domain?.codedValues ?? []).map((coded) => ({
    value: String(coded.code),
    label: coded.name || String(coded.code),
  }));
}

// ── raw control input → typed attribute value ────────────────────────────

/**
 * Coerces raw control input (always a string from a DOM `value`, or a boolean
 * from a checkbox) to the typed attribute value the source expects.
 *
 * Coded-value fields resolve back to the domain code's own type, so a numeric
 * subtype or status code round-trips as a number rather than the `"3"` an
 * `<option value>` carries — otherwise every coded-value edit would fail the
 * contract's own domain check.
 */
export function coerceEditorFieldValue(field: EditWorkflowField, raw: string | boolean | null): unknown {
  if (typeof raw === "boolean") return raw;
  if (raw === null) return null;
  const kind = editorControlKind(field);
  if (kind === "select") {
    const coded = (field.domain?.codedValues ?? []).find((entry) => String(entry.code) === raw);
    if (coded) return coded.code;
    return raw === "" ? emptyValueFor(field) : raw;
  }
  if (raw === "") return emptyValueFor(field);
  if (kind === "checkbox") return raw === "true" || raw === "on";
  if (kind === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

function emptyValueFor(field: EditWorkflowField): unknown {
  return field.nullable === false ? "" : null;
}

/** Renders a typed attribute value as the string a DOM control carries. */
export function editorFieldInputValue(field: EditWorkflowField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return isoForControl(editorControlKind(field), value);
  if (typeof value === "number" && (editorControlKind(field) === "date" || editorControlKind(field) === "datetime")) {
    return isoForControl(editorControlKind(field), new Date(value));
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isoForControl(kind: HonuaEditorControlKind, date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const iso = date.toISOString();
  return kind === "datetime" ? iso.slice(0, 16) : iso.slice(0, 10);
}

// ── attachment drafts (never carry the payload) ──────────────────────────

/**
 * A staged attachment as the editor exposes it: descriptive metadata only.
 *
 * The payload itself (a `Blob`/`File`, or a string that may be a signed URL
 * carrying credentials) stays inside the edit session and is never copied into
 * a snapshot or an emitted event (REQ-004 / issue #680's data notes).
 */
export interface HonuaEditorAttachmentDraft {
  readonly index: number;
  readonly operation: "add" | "update" | "delete";
  readonly name: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly status: "staged" | "applied" | "failed" | "skipped";
  readonly error?: string;
}

/** Structural shape of one staged attachment mutation. */
export interface HonuaEditorAttachmentMutationLike {
  readonly operation: "add" | "update" | "delete";
  readonly attachment?: unknown;
  readonly name?: string;
  readonly contentType?: string;
  readonly attachmentIds?: readonly (string | number)[];
}

/**
 * Redacts a staged attachment mutation down to safe descriptive metadata.
 * String payloads (potentially credential-bearing URLs) never survive: only a
 * `name`, which falls back to a neutral placeholder rather than the payload.
 */
export function redactEditorAttachment(
  mutation: HonuaEditorAttachmentMutationLike,
  index: number,
  status: HonuaEditorAttachmentDraft["status"] = "staged",
  error?: string,
): HonuaEditorAttachmentDraft {
  const payload = mutation.attachment;
  const blobLike = payload as { name?: unknown; size?: unknown; type?: unknown } | undefined;
  const name =
    mutation.name ??
    (typeof blobLike?.name === "string" ? blobLike.name : undefined) ??
    (mutation.operation === "delete" ? `${mutation.attachmentIds?.length ?? 0} attachment(s)` : "attachment");
  return {
    index,
    operation: mutation.operation,
    name,
    ...((mutation.contentType ?? (typeof blobLike?.type === "string" && blobLike.type))
      ? { contentType: mutation.contentType ?? (blobLike?.type as string) }
      : {}),
    ...(typeof blobLike?.size === "number" ? { size: blobLike.size } : {}),
    status,
    ...(error ? { error } : {}),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function sameCode(left: string | number, right: unknown): boolean {
  if (left === right) return true;
  return String(left) === String(right);
}

function subtypeCodeOf(value: unknown): string | number | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  return undefined;
}
