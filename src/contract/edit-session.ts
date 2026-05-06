import { HonuaCapabilityNotSupportedError, HonuaHttpError, HonuaWfsExceptionError } from "../core/errors.js";
import type { HonuaFieldInfo } from "../core/types.js";
import type {
  AttachmentEditOutcome,
  AttachmentQuery,
  CanonicalFeature,
  DegradedReason,
  EditEnvelope,
  EditOutcome,
  EditResult,
  FeatureId,
  Protocol,
  RelatedQuery,
  RelatedResult,
  Source,
  SourceId,
} from "./types.js";

export type EditWorkflowKind = "create" | "update" | "delete";
export type EditWorkflowCapabilityState = "supported" | "unsupported";
export type EditWorkflowConflictState = "supported" | "unsupported" | "unknown";
export type EditWorkflowStatus = "succeeded" | "partial" | "failed" | "validation-failed" | "unsupported";
export type EditWorkflowFailureKind =
  | "validation"
  | "conflict"
  | "capability"
  | "transport"
  | "server"
  | "partial-failure"
  | "unknown";
export type EditWorkflowOperation =
  | "add"
  | "update"
  | "delete"
  | "attachment-add"
  | "attachment-update"
  | "attachment-delete"
  | "session";

export interface EditFieldDomainCodedValue {
  name: string;
  code: string | number | boolean | null;
}

export interface EditFieldDomain {
  type: "coded-value" | "range";
  name?: string;
  codedValues?: readonly EditFieldDomainCodedValue[];
  range?: readonly [number, number];
}

export interface EditWorkflowField {
  name: string;
  type?: string;
  alias?: string;
  length?: number;
  nullable?: boolean;
  editable?: boolean;
  defaultValue?: unknown;
  required?: boolean;
  domain?: EditFieldDomain;
}

export interface EditWorkflowRelationship {
  relationshipId: number;
  name?: string;
  relatedSourceId?: SourceId;
  cardinality?: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many" | (string & {});
}

export interface EditWorkflowConflictInfo {
  state: EditWorkflowConflictState;
  versionField?: string;
  etagField?: string;
  updatedAtField?: string;
  value?: unknown;
  reason?: string;
}

export interface EditWorkflowMetadata {
  fields: readonly EditWorkflowField[];
  primaryKey?: string;
  relationships: readonly EditWorkflowRelationship[];
  attachments: EditWorkflowCapabilityState;
  conflict: EditWorkflowConflictInfo;
}

export interface EditWorkflowMetadataOptions {
  fields?: readonly EditWorkflowField[];
  domains?: Readonly<Record<string, EditFieldDomain>>;
  relationships?: readonly EditWorkflowRelationship[];
  primaryKey?: string;
  conflict?: Partial<EditWorkflowConflictInfo>;
}

export interface EditWorkflowCapabilitySummary {
  applyEdits: EditWorkflowCapabilityState;
  attachments: EditWorkflowCapabilityState;
  relationships: EditWorkflowCapabilityState;
  conflicts: EditWorkflowConflictState;
}

export interface EditWorkflowValidationError {
  fieldName?: string;
  code: "required" | "domain" | "range" | "length" | "read-only" | "unsupported";
  message: string;
  value?: unknown;
}

export interface EditWorkflowValidationResult {
  valid: boolean;
  errors: readonly EditWorkflowValidationError[];
}

export interface EditWorkflowSnapshot<T = Record<string, unknown>> {
  sourceId: SourceId;
  protocol: Protocol;
  kind: EditWorkflowKind;
  feature: CanonicalFeature<T>;
  attachments: readonly EditAttachmentMutation[];
  metadata: EditWorkflowMetadata;
}

export interface EditWorkflowOptimisticHooks<T = Record<string, unknown>> {
  apply?(snapshot: EditWorkflowSnapshot<T>): void | Promise<void>;
  rollback?(snapshot: EditWorkflowSnapshot<T>, result: EditWorkflowSubmitResult<T>): void | Promise<void>;
  commit?(snapshot: EditWorkflowSnapshot<T>, result: EditWorkflowSubmitResult<T>): void | Promise<void>;
}

export interface CreateEditSessionOptions<T = Record<string, unknown>> {
  source: Source<T>;
  kind?: EditWorkflowKind;
  feature?: CanonicalFeature<T>;
  values?: Partial<T>;
  geometry?: Record<string, unknown> | null;
  metadata?: EditWorkflowMetadataOptions;
  rollbackOnFailure?: boolean;
  signal?: AbortSignal;
  optimistic?: EditWorkflowOptimisticHooks<T>;
}

export type EditAttachmentMutation =
  | {
      operation: "add";
      parentId?: FeatureId;
      attachment: Blob | File | string;
      name?: string;
      contentType?: string;
    }
  | {
      operation: "update";
      parentId?: FeatureId;
      attachmentId: FeatureId;
      attachment: Blob | File | string;
      name?: string;
      contentType?: string;
    }
  | {
      operation: "delete";
      parentId?: FeatureId;
      attachmentIds: readonly FeatureId[];
    };

export interface EditAttachmentMutationOutcome {
  operation: EditAttachmentMutation["operation"];
  index: number;
  outcomes: readonly AttachmentEditOutcome[];
}

export interface EditWorkflowFailure {
  kind: EditWorkflowFailureKind;
  operation: EditWorkflowOperation;
  index?: number;
  id?: FeatureId;
  attachmentId?: FeatureId;
  code?: number;
  description: string;
  sourceId?: SourceId;
  protocol?: Protocol;
  conflict?: EditWorkflowConflictInfo;
}

export interface NormalizeEditWorkflowFailuresOptions {
  sourceId?: SourceId;
  protocol?: Protocol;
  conflict?: EditWorkflowConflictInfo;
}

export interface EditWorkflowSubmitResult<T = Record<string, unknown>> {
  status: EditWorkflowStatus;
  sourceId: SourceId;
  protocol: Protocol;
  validation: EditWorkflowValidationResult;
  editResult?: EditResult;
  attachmentResults: readonly EditAttachmentMutationOutcome[];
  failures: readonly EditWorkflowFailure[];
  degraded?: readonly DegradedReason[];
  conflict?: EditWorkflowConflictInfo;
  committedFeatureId?: FeatureId;
  optimistic: {
    applied: boolean;
    rolledBack: boolean;
  };
  snapshot: EditWorkflowSnapshot<T>;
}

export class EditWorkflowSession<T = Record<string, unknown>> {
  public readonly source: Source<T>;
  public readonly kind: EditWorkflowKind;
  private readonly options: Omit<CreateEditSessionOptions<T>, "source" | "feature" | "values" | "geometry">;
  private readonly initialAttributes: Record<string, unknown>;
  private readonly metadataValue: EditWorkflowMetadata;
  private readonly attachmentMutations: EditAttachmentMutation[] = [];
  private feature: CanonicalFeature<T>;

  public constructor(options: CreateEditSessionOptions<T>) {
    this.source = options.source;
    this.kind = options.kind ?? (options.feature?.id === undefined ? "create" : "update");
    const attributes = {
      ...((options.feature?.attributes ?? {}) as Record<string, unknown>),
      ...((options.values ?? {}) as Record<string, unknown>),
    };
    this.initialAttributes = { ...((options.feature?.attributes ?? {}) as Record<string, unknown>) };
    this.feature = {
      ...(options.feature?.id !== undefined ? { id: options.feature.id } : {}),
      attributes: attributes as T,
      ...(options.geometry !== undefined
        ? { geometry: options.geometry }
        : options.feature?.geometry !== undefined
          ? { geometry: options.feature.geometry }
          : {}),
    };
    this.options = {
      kind: this.kind,
      metadata: options.metadata,
      rollbackOnFailure: options.rollbackOnFailure,
      signal: options.signal,
      optimistic: options.optimistic,
    };
    this.metadataValue = resolveEditWorkflowMetadata(this.source, options.metadata, this.feature);
  }

  public metadata(): EditWorkflowMetadata {
    return this.metadataValue;
  }

  public capabilities(): EditWorkflowCapabilitySummary {
    const caps = this.source.capabilities;
    return {
      applyEdits: caps.has("applyEdits") ? "supported" : "unsupported",
      attachments: caps.has("attachments") ? "supported" : "unsupported",
      relationships: caps.has("queryRelated") ? "supported" : "unsupported",
      conflicts: this.metadataValue.conflict.state,
    };
  }

  public snapshot(): EditWorkflowSnapshot<T> {
    return {
      sourceId: this.source.descriptor.id,
      protocol: this.source.descriptor.protocol,
      kind: this.kind,
      feature: cloneCanonicalFeature(this.feature),
      attachments: this.attachmentMutations.map(cloneAttachmentMutation),
      metadata: this.metadataValue,
    };
  }

  public values(): Readonly<Record<string, unknown>> {
    return { ...(this.feature.attributes as Record<string, unknown>) };
  }

  public setValue(fieldName: string, value: unknown): this {
    this.feature = {
      ...this.feature,
      attributes: {
        ...(this.feature.attributes as Record<string, unknown>),
        [fieldName]: value,
      } as T,
    };
    return this;
  }

  public setValues(values: Partial<T>): this {
    this.feature = {
      ...this.feature,
      attributes: {
        ...(this.feature.attributes as Record<string, unknown>),
        ...(values as Record<string, unknown>),
      } as T,
    };
    return this;
  }

  public setGeometry(geometry: Record<string, unknown> | null): this {
    this.feature = { ...this.feature, geometry };
    return this;
  }

  public setId(id: FeatureId): this {
    this.feature = { ...this.feature, id };
    return this;
  }

  public stageAttachmentAdd(
    attachment: Blob | File | string,
    options: { parentId?: FeatureId; name?: string; contentType?: string } = {},
  ): this {
    this.attachmentMutations.push({
      operation: "add",
      attachment,
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    });
    return this;
  }

  public stageAttachmentUpdate(
    attachmentId: FeatureId,
    attachment: Blob | File | string,
    options: { parentId?: FeatureId; name?: string; contentType?: string } = {},
  ): this {
    this.attachmentMutations.push({
      operation: "update",
      attachmentId,
      attachment,
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    });
    return this;
  }

  public stageAttachmentDelete(attachmentIds: readonly FeatureId[], options: { parentId?: FeatureId } = {}): this {
    this.attachmentMutations.push({
      operation: "delete",
      attachmentIds: [...attachmentIds],
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
    });
    return this;
  }

  public pendingAttachments(): readonly EditAttachmentMutation[] {
    return this.attachmentMutations.map(cloneAttachmentMutation);
  }

  public async listAttachments(parentId?: FeatureId, options: { signal?: AbortSignal } = {}) {
    const resolvedParentId = parentId ?? this.feature.id;
    if (resolvedParentId === undefined) {
      throw new Error("EditWorkflowSession.listAttachments requires a parent id");
    }
    return this.source.attachments.list(resolvedParentId, options);
  }

  public async queryAttachments(request: AttachmentQuery = {}) {
    return this.source.attachments.query(request);
  }

  public async queryRelated<R = Record<string, unknown>>(
    relationshipId: number,
    options: Omit<RelatedQuery, "relationshipId" | "sourceIds"> & { sourceIds?: readonly FeatureId[] } = {},
  ): Promise<RelatedResult<R>> {
    const sourceIds = options.sourceIds ?? (this.feature.id !== undefined ? [this.feature.id] : undefined);
    if (!sourceIds || sourceIds.length === 0) {
      throw new Error("EditWorkflowSession.queryRelated requires sourceIds or a feature id");
    }
    const { sourceIds: _sourceIds, ...rest } = options;
    return this.source.queryRelated<R>({ ...rest, relationshipId, sourceIds });
  }

  public validate(): EditWorkflowValidationResult {
    const errors: EditWorkflowValidationError[] = [];
    const values = this.feature.attributes as Record<string, unknown>;
    const fieldByName = new Map(this.metadataValue.fields.map((field) => [field.name, field]));

    if (this.capabilities().applyEdits === "unsupported") {
      errors.push({
        code: "unsupported",
        message: `Source "${this.source.descriptor.id}" does not support applyEdits`,
      });
    }
    if (this.kind === "delete" && this.feature.id === undefined) {
      errors.push({ code: "required", message: "Delete workflows require a feature id" });
    }
    if (this.kind === "update" && this.feature.id === undefined) {
      errors.push({ code: "required", message: "Update workflows require a feature id" });
    }
    if (this.attachmentMutations.length > 0 && this.capabilities().attachments === "unsupported") {
      errors.push({
        code: "unsupported",
        message: `Source "${this.source.descriptor.id}" does not support attachments`,
      });
    }

    for (const field of fieldByName.values()) {
      const value = values[field.name];
      const serverAssignedOnCreate = this.kind === "create" && field.editable === false;
      const required = (field.required === true || field.nullable === false) && !serverAssignedOnCreate;
      if (required && isEmptyValue(value) && field.defaultValue === undefined) {
        errors.push({
          fieldName: field.name,
          code: "required",
          message: `${field.alias ?? field.name} is required`,
          value,
        });
      }
      if (field.editable === false && Object.hasOwn(values, field.name)) {
        const initial = this.initialAttributes[field.name];
        if (this.kind === "create" || !sameValue(value, initial)) {
          errors.push({
            fieldName: field.name,
            code: "read-only",
            message: `${field.alias ?? field.name} is read-only`,
            value,
          });
        }
      }
      if (typeof field.length === "number" && typeof value === "string" && value.length > field.length) {
        errors.push({
          fieldName: field.name,
          code: "length",
          message: `${field.alias ?? field.name} exceeds length ${field.length}`,
          value,
        });
      }
      const domainError = validateDomain(field, value);
      if (domainError) errors.push(domainError);
    }

    return { valid: errors.length === 0, errors };
  }

  public async submit(overrides: Partial<T> = {}): Promise<EditWorkflowSubmitResult<T>> {
    if (Object.keys(overrides as Record<string, unknown>).length > 0) this.setValues(overrides);
    const validation = this.validate();
    const preflightSnapshot = this.snapshot();
    if (!validation.valid) {
      return this.resultFromFailures({
        status: validation.errors.some((e) => e.code === "unsupported") ? "unsupported" : "validation-failed",
        validation,
        snapshot: preflightSnapshot,
        failures: validationErrorsToFailures(validation.errors, this.source),
        optimistic: { applied: false, rolledBack: false },
      });
    }

    let optimisticApplied = false;
    let optimisticRolledBack = false;
    const hooks = this.options.optimistic;
    if (hooks?.apply) {
      await hooks.apply(preflightSnapshot);
      optimisticApplied = true;
    }

    let editResult: EditResult | undefined;
    let attachmentResults: readonly EditAttachmentMutationOutcome[] = [];
    let failures: readonly EditWorkflowFailure[] = [];
    try {
      editResult = await this.source.applyEdits(this.toEnvelope());
      const committedFeatureId = committedIdFor(this.kind, this.feature, editResult);
      attachmentResults =
        featureEditCommitted(this.kind, editResult) || this.attachmentMutations.length === 0
          ? await this.applyAttachmentMutations(committedFeatureId)
          : skippedAttachmentMutations(this.attachmentMutations);
      failures = normalizeEditWorkflowFailures({
        editResult,
        attachmentResults,
        sourceId: this.source.descriptor.id,
        protocol: this.source.descriptor.protocol,
        conflict: this.metadataValue.conflict,
      });
      const status = statusFromFailures(failures, editResult, attachmentResults);
      const result = this.resultFromFailures({
        status,
        validation,
        snapshot: preflightSnapshot,
        editResult,
        attachmentResults,
        failures,
        committedFeatureId,
        optimistic: { applied: optimisticApplied, rolledBack: false },
      });
      if (status === "succeeded") {
        if (hooks?.commit) await hooks.commit(preflightSnapshot, result);
        return result;
      }
      if (optimisticApplied && hooks?.rollback) {
        await hooks.rollback(preflightSnapshot, result);
        optimisticRolledBack = true;
      }
      return { ...result, optimistic: { applied: optimisticApplied, rolledBack: optimisticRolledBack } };
    } catch (err) {
      const failure = failureFromThrown(err, this.source, this.metadataValue.conflict);
      const result = this.resultFromFailures({
        status: failure.kind === "capability" ? "unsupported" : "failed",
        validation,
        snapshot: preflightSnapshot,
        editResult,
        attachmentResults,
        failures: [failure],
        optimistic: { applied: optimisticApplied, rolledBack: false },
      });
      if (optimisticApplied && hooks?.rollback) {
        await hooks.rollback(preflightSnapshot, result);
        optimisticRolledBack = true;
      }
      return { ...result, optimistic: { applied: optimisticApplied, rolledBack: optimisticRolledBack } };
    }
  }

  private toEnvelope(): EditEnvelope<T> {
    const envelope: EditEnvelope<T> = {
      rollbackOnFailure: this.options.rollbackOnFailure,
      signal: this.options.signal,
    };
    if (this.kind === "create") envelope.adds = [cloneCanonicalFeature(this.feature)];
    if (this.kind === "update") envelope.updates = [cloneCanonicalFeature(this.feature)];
    if (this.kind === "delete" && this.feature.id !== undefined) envelope.deletes = [this.feature.id];
    return envelope;
  }

  private async applyAttachmentMutations(
    committedFeatureId: FeatureId | undefined,
  ): Promise<EditAttachmentMutationOutcome[]> {
    const out: EditAttachmentMutationOutcome[] = [];
    for (let i = 0; i < this.attachmentMutations.length; i += 1) {
      const mutation = this.attachmentMutations[i];
      const parentId = mutation.parentId ?? committedFeatureId;
      if (parentId === undefined) {
        out.push({
          operation: mutation.operation,
          index: i,
          outcomes: [
            {
              success: false,
              error: { code: 400, description: "attachment parentId is required" },
            },
          ],
        });
        continue;
      }
      try {
        if (mutation.operation === "add") {
          const added = await this.source.attachments.add({
            parentId,
            attachment: mutation.attachment,
            ...(mutation.name !== undefined ? { name: mutation.name } : {}),
            ...(mutation.contentType !== undefined ? { contentType: mutation.contentType } : {}),
            ...(this.options.signal ? { signal: this.options.signal } : {}),
          });
          out.push({ operation: "add", index: i, outcomes: [added] });
        } else if (mutation.operation === "update") {
          const updated = await this.source.attachments.update({
            parentId,
            attachmentId: mutation.attachmentId,
            attachment: mutation.attachment,
            ...(mutation.name !== undefined ? { name: mutation.name } : {}),
            ...(mutation.contentType !== undefined ? { contentType: mutation.contentType } : {}),
            ...(this.options.signal ? { signal: this.options.signal } : {}),
          });
          out.push({ operation: "update", index: i, outcomes: [updated] });
        } else {
          const deleted = await this.source.attachments.delete({
            parentId,
            attachmentIds: mutation.attachmentIds,
            ...(this.options.signal ? { signal: this.options.signal } : {}),
          });
          out.push({ operation: "delete", index: i, outcomes: deleted });
        }
      } catch (err) {
        out.push({
          operation: mutation.operation,
          index: i,
          outcomes: [attachmentOutcomeFromThrown(err, parentId)],
        });
      }
    }
    return out;
  }

  private resultFromFailures(input: {
    status: EditWorkflowStatus;
    validation: EditWorkflowValidationResult;
    snapshot: EditWorkflowSnapshot<T>;
    editResult?: EditResult;
    attachmentResults?: readonly EditAttachmentMutationOutcome[];
    failures: readonly EditWorkflowFailure[];
    committedFeatureId?: FeatureId;
    optimistic: { applied: boolean; rolledBack: boolean };
  }): EditWorkflowSubmitResult<T> {
    const conflict = input.failures.find((f) => f.kind === "conflict")?.conflict;
    const degraded = input.editResult?.degraded;
    return {
      status: input.status,
      sourceId: this.source.descriptor.id,
      protocol: this.source.descriptor.protocol,
      validation: input.validation,
      ...(input.editResult ? { editResult: input.editResult } : {}),
      attachmentResults: input.attachmentResults ?? [],
      failures: input.failures,
      ...(degraded && degraded.length > 0 ? { degraded } : {}),
      ...(conflict ? { conflict } : {}),
      ...(input.committedFeatureId !== undefined ? { committedFeatureId: input.committedFeatureId } : {}),
      optimistic: input.optimistic,
      snapshot: input.snapshot,
    };
  }
}

export function createEditSession<T = Record<string, unknown>>(
  options: CreateEditSessionOptions<T>,
): EditWorkflowSession<T> {
  return new EditWorkflowSession(options);
}

export function normalizeEditWorkflowFailures(
  result:
    | EditResult
    | (NormalizeEditWorkflowFailuresOptions & {
        editResult?: EditResult;
        attachmentResults?: readonly EditAttachmentMutationOutcome[];
      }),
  options: NormalizeEditWorkflowFailuresOptions = {},
): readonly EditWorkflowFailure[] {
  const input = isEditResult(result) ? { editResult: result, ...options } : result;
  const failures: EditWorkflowFailure[] = [];
  collectEditOutcomeFailures(failures, "add", input.editResult?.added, input);
  collectEditOutcomeFailures(failures, "update", input.editResult?.updated, input);
  collectEditOutcomeFailures(failures, "delete", input.editResult?.deleted, input);
  for (const attachment of input.attachmentResults ?? []) {
    const operation = attachmentOperationToWorkflowOperation(attachment.operation);
    for (let i = 0; i < attachment.outcomes.length; i += 1) {
      const outcome = attachment.outcomes[i];
      if (outcome.success) continue;
      failures.push(failureFromAttachmentOutcome(outcome, operation, attachment.index, input));
    }
  }
  return failures;
}

function resolveEditWorkflowMetadata<T>(
  source: Source<T>,
  options: EditWorkflowMetadataOptions | undefined,
  feature: CanonicalFeature<T>,
): EditWorkflowMetadata {
  const schemaFields = source.descriptor.schema?.fields ?? [];
  const rawFields = options?.fields ?? schemaFields.map(fieldInfoToEditField);
  const fields = rawFields.map((field) => ({
    ...field,
    ...(field.domain ? {} : options?.domains?.[field.name] ? { domain: options.domains[field.name] } : {}),
  }));
  const primaryKey = options?.primaryKey ?? source.descriptor.schema?.primaryKey;
  const conflict = resolveConflictInfo(fields, feature, options?.conflict);
  return {
    fields,
    ...(primaryKey ? { primaryKey } : {}),
    relationships: options?.relationships ?? [],
    attachments: source.capabilities.has("attachments") ? "supported" : "unsupported",
    conflict,
  };
}

function fieldInfoToEditField(field: HonuaFieldInfo): EditWorkflowField {
  return {
    name: field.name,
    type: field.type,
    ...(field.alias !== undefined ? { alias: field.alias } : {}),
    ...(field.length !== undefined ? { length: field.length } : {}),
    ...(field.nullable !== undefined ? { nullable: field.nullable } : {}),
    ...(field.editable !== undefined ? { editable: field.editable } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
  };
}

function resolveConflictInfo<T>(
  fields: readonly EditWorkflowField[],
  feature: CanonicalFeature<T>,
  explicit: Partial<EditWorkflowConflictInfo> | undefined,
): EditWorkflowConflictInfo {
  const versionField =
    explicit?.versionField ??
    fields.find((f) => /^version$/i.test(f.name) || /row.?version/i.test(f.name) || /edit.?version/i.test(f.name))
      ?.name;
  const etagField = explicit?.etagField ?? fields.find((f) => /^etag$/i.test(f.name) || /^_?etag$/i.test(f.name))?.name;
  const updatedAtField =
    explicit?.updatedAtField ??
    fields.find((f) => /^(updatedAt|updated_at|last_edited_date|modifiedAt|modified_at)$/i.test(f.name))?.name;
  const attributes = feature.attributes as Record<string, unknown>;
  const value =
    explicit?.value ??
    (versionField && attributes[versionField] !== undefined
      ? attributes[versionField]
      : etagField && attributes[etagField] !== undefined
        ? attributes[etagField]
        : updatedAtField && attributes[updatedAtField] !== undefined
          ? attributes[updatedAtField]
          : undefined);
  const inferredSupported = versionField !== undefined || etagField !== undefined || updatedAtField !== undefined;
  return {
    state: explicit?.state ?? (inferredSupported ? "supported" : "unsupported"),
    ...(versionField ? { versionField } : {}),
    ...(etagField ? { etagField } : {}),
    ...(updatedAtField ? { updatedAtField } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(explicit?.reason ? { reason: explicit.reason } : {}),
  };
}

function validateDomain(field: EditWorkflowField, value: unknown): EditWorkflowValidationError | undefined {
  if (isEmptyValue(value) || !field.domain) return undefined;
  if (field.domain.type === "coded-value") {
    const allowed = new Set((field.domain.codedValues ?? []).map((coded) => coded.code));
    if (allowed.size > 0 && !allowed.has(value as string | number | boolean | null)) {
      return {
        fieldName: field.name,
        code: "domain",
        message: `${field.alias ?? field.name} must match its coded-value domain`,
        value,
      };
    }
  }
  if (field.domain.type === "range" && field.domain.range) {
    const [min, max] = field.domain.range;
    if (typeof value !== "number" || value < min || value > max) {
      return {
        fieldName: field.name,
        code: "range",
        message: `${field.alias ?? field.name} must be between ${min} and ${max}`,
        value,
      };
    }
  }
  return undefined;
}

function collectEditOutcomeFailures(
  failures: EditWorkflowFailure[],
  operation: "add" | "update" | "delete",
  outcomes: readonly EditOutcome[] | undefined,
  options: NormalizeEditWorkflowFailuresOptions,
): void {
  for (let i = 0; i < (outcomes ?? []).length; i += 1) {
    const outcome = outcomes?.[i];
    if (!outcome || outcome.success) continue;
    failures.push(failureFromEditOutcome(outcome, operation, i, options));
  }
}

function failureFromEditOutcome(
  outcome: EditOutcome,
  operation: "add" | "update" | "delete",
  index: number,
  options: NormalizeEditWorkflowFailuresOptions,
): EditWorkflowFailure {
  const description = outcome.error?.description ?? "Edit outcome failed without protocol detail";
  const code = outcome.error?.code;
  const kind = classifyFailure(code, description);
  const conflict = kind === "conflict" ? conflictFromFailure(description, options.conflict) : undefined;
  return {
    kind,
    operation,
    index,
    ...(outcome.id !== undefined ? { id: outcome.id } : {}),
    ...(code !== undefined ? { code } : {}),
    description,
    ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
    ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

function failureFromAttachmentOutcome(
  outcome: AttachmentEditOutcome,
  operation: EditWorkflowOperation,
  index: number,
  options: NormalizeEditWorkflowFailuresOptions,
): EditWorkflowFailure {
  const description = outcome.error?.description ?? "Attachment outcome failed without protocol detail";
  const code = outcome.error?.code;
  const kind = classifyFailure(code, description);
  const conflict = kind === "conflict" ? conflictFromFailure(description, options.conflict) : undefined;
  return {
    kind,
    operation,
    index,
    ...(outcome.attachmentId !== undefined ? { attachmentId: outcome.attachmentId } : {}),
    ...(code !== undefined ? { code } : {}),
    description,
    ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
    ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

function failureFromThrown<T>(
  err: unknown,
  source: Source<T>,
  conflict: EditWorkflowConflictInfo,
): EditWorkflowFailure {
  const sourceId = source.descriptor.id;
  const protocol = source.descriptor.protocol;
  if (err instanceof HonuaCapabilityNotSupportedError) {
    return {
      kind: "capability",
      operation: "session",
      code: 0,
      description: err.message,
      sourceId,
      protocol,
    };
  }
  if (err instanceof HonuaHttpError) {
    const kind = classifyFailure(err.statusCode, err.message);
    return {
      kind,
      operation: "session",
      code: err.statusCode,
      description: err.message,
      sourceId,
      protocol,
      ...(kind === "conflict" ? { conflict: conflictFromFailure(err.message, conflict) } : {}),
    };
  }
  if (err instanceof HonuaWfsExceptionError) {
    const kind = classifyFailure(400, err.message);
    return {
      kind,
      operation: "session",
      code: 400,
      description: err.message,
      sourceId,
      protocol,
      ...(kind === "conflict" ? { conflict: conflictFromFailure(err.message, conflict) } : {}),
    };
  }
  if (err instanceof Error) {
    const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown };
    const code =
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.status === "number"
          ? candidate.status
          : typeof candidate.code === "number"
            ? candidate.code
            : undefined;
    const kind = classifyFailure(code, err.message);
    return {
      kind,
      operation: "session",
      ...(code !== undefined ? { code } : {}),
      description: err.message,
      sourceId,
      protocol,
      ...(kind === "conflict" ? { conflict: conflictFromFailure(err.message, conflict) } : {}),
    };
  }
  return {
    kind: "unknown",
    operation: "session",
    description: String(err),
    sourceId,
    protocol,
  };
}

function attachmentOutcomeFromThrown(err: unknown, parentId: FeatureId): AttachmentEditOutcome {
  if (err instanceof HonuaHttpError) {
    return {
      parentId,
      success: false,
      error: { code: err.statusCode, description: err.message },
    };
  }
  if (err instanceof HonuaCapabilityNotSupportedError) {
    return {
      parentId,
      success: false,
      error: { code: 0, description: err.message },
    };
  }
  if (err instanceof Error) {
    const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown };
    const code =
      typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : typeof candidate.status === "number"
          ? candidate.status
          : typeof candidate.code === "number"
            ? candidate.code
            : 500;
    return { parentId, success: false, error: { code, description: err.message } };
  }
  return { parentId, success: false, error: { code: 500, description: String(err) } };
}

function validationErrorsToFailures<T>(
  errors: readonly EditWorkflowValidationError[],
  source: Source<T>,
): readonly EditWorkflowFailure[] {
  return errors.map((error) => ({
    kind: error.code === "unsupported" ? "capability" : "validation",
    operation: "session",
    ...(error.code === "unsupported" ? { code: 0 } : {}),
    description: error.message,
    sourceId: source.descriptor.id,
    protocol: source.descriptor.protocol,
  }));
}

function classifyFailure(code: number | undefined, description: string): EditWorkflowFailureKind {
  const normalized = description.toLowerCase();
  if (code === 409 || code === 412 || /conflict|precondition|stale|version|etag/.test(normalized)) return "conflict";
  if (code === 0) return "capability";
  if (code === 400 || code === 422) return "validation";
  if (typeof code === "number" && code >= 500) return "server";
  if (typeof code === "number" && code >= 400) return "transport";
  return "partial-failure";
}

function conflictFromFailure(
  description: string,
  conflict: EditWorkflowConflictInfo | undefined,
): EditWorkflowConflictInfo {
  return {
    state: conflict?.state === "supported" ? "supported" : "unknown",
    ...(conflict?.versionField ? { versionField: conflict.versionField } : {}),
    ...(conflict?.etagField ? { etagField: conflict.etagField } : {}),
    ...(conflict?.updatedAtField ? { updatedAtField: conflict.updatedAtField } : {}),
    ...(conflict?.value !== undefined ? { value: conflict.value } : {}),
    reason: description,
  };
}

function committedIdFor<T>(
  kind: EditWorkflowKind,
  feature: CanonicalFeature<T>,
  result: EditResult,
): FeatureId | undefined {
  if (kind === "create") {
    const outcome = result.added[0];
    return outcome?.success ? (outcome.id ?? feature.id) : undefined;
  }
  if (kind === "delete") {
    return result.deleted[0]?.success ? feature.id : undefined;
  }
  const outcome = result.updated[0];
  return outcome?.success ? (outcome.id ?? feature.id) : undefined;
}

function featureEditCommitted(kind: EditWorkflowKind, result: EditResult): boolean {
  if (kind === "create") return result.added[0]?.success === true;
  if (kind === "update") return result.updated[0]?.success === true;
  return result.deleted[0]?.success === true;
}

function skippedAttachmentMutations(
  mutations: readonly EditAttachmentMutation[],
): readonly EditAttachmentMutationOutcome[] {
  return mutations.map((mutation, index) => ({
    operation: mutation.operation,
    index,
    outcomes: [
      {
        success: false,
        error: { code: 409, description: "attachment mutation skipped because the feature edit did not commit" },
      },
    ],
  }));
}

function statusFromFailures(
  failures: readonly EditWorkflowFailure[],
  editResult: EditResult | undefined,
  attachmentResults: readonly EditAttachmentMutationOutcome[],
): EditWorkflowStatus {
  if (failures.length === 0) return "succeeded";
  const editOutcomes = [
    ...(editResult?.added ?? []),
    ...(editResult?.updated ?? []),
    ...(editResult?.deleted ?? []),
    ...attachmentResults.flatMap((result) => result.outcomes),
  ];
  const successCount = editOutcomes.filter((outcome) => outcome.success).length;
  return successCount > 0 ? "partial" : "failed";
}

function isEditResult(value: unknown): value is EditResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { added?: unknown }).added) &&
    Array.isArray((value as { updated?: unknown }).updated) &&
    Array.isArray((value as { deleted?: unknown }).deleted)
  );
}

function attachmentOperationToWorkflowOperation(operation: EditAttachmentMutation["operation"]): EditWorkflowOperation {
  if (operation === "add") return "attachment-add";
  if (operation === "update") return "attachment-update";
  return "attachment-delete";
}

function cloneCanonicalFeature<T>(feature: CanonicalFeature<T>): CanonicalFeature<T> {
  return {
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    attributes: { ...(feature.attributes as Record<string, unknown>) } as T,
    ...(feature.geometry !== undefined ? { geometry: cloneRecord(feature.geometry) } : {}),
  };
}

function cloneAttachmentMutation(mutation: EditAttachmentMutation): EditAttachmentMutation {
  if (mutation.operation === "add") return { ...mutation };
  if (mutation.operation === "update") return { ...mutation };
  return { ...mutation, attachmentIds: [...mutation.attachmentIds] };
}

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return { ...value };
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}
