import {
  type FormExpressionField,
  type FormExpressionResult,
  evaluateFormExpressions,
} from "../widget-capabilities.js";
import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { type HonuaWidgetHost, bindHonuaWidgetHost, pushWidgetHostState } from "./widget-host.js";

export interface FeatureFormCompatOptions {
  view?: unknown;
  layer?: unknown;
  container?: unknown;
  feature?: unknown;
  formTemplate?: unknown;
  fieldConfig?: readonly unknown[];
  groupDisplay?: string;
  headingLevel?: number;
  visibleElements?: unknown;
  validationFunction?: FeatureFormValidationFn;
  eventBus?: CompatEventBus;
}

export interface FeatureFormSubmitResultCompat {
  valid: boolean;
  values: Readonly<Record<string, unknown>>;
  feature: unknown;
  errors?: readonly FeatureFormFieldErrorCompat[];
}

export interface FeatureFormFieldErrorCompat {
  fieldName: string;
  errorMessage: string;
  type: "required" | "range" | "pattern" | "custom";
}

export type FeatureFormValidationFn = (fieldName: string, value: unknown) => FeatureFormFieldErrorCompat | undefined;

export type FeatureFormLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface FeatureFormHandleCompat {
  remove(): void;
}

export class FeatureFormCompat {
  public readonly view: unknown;
  public readonly layer: unknown;
  public readonly container: unknown;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: FeatureFormLoadStatusCompat;
  public feature: unknown;
  public formTemplate: unknown;
  public expressionResult: FormExpressionResult | undefined;
  public fieldConfig: readonly unknown[];
  public groupDisplay: string | undefined;
  public headingLevel: number | undefined;
  public visibleElements: unknown;
  public validationFunction: FeatureFormValidationFn | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly widgetHost: HonuaWidgetHost | undefined;

  public constructor(options: FeatureFormCompatOptions = {}) {
    this.view = options.view;
    this.layer = options.layer;
    this.container = options.container;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view, options.layer) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.feature = options.feature;
    this.formTemplate = options.formTemplate;
    this.fieldConfig = options.fieldConfig ? [...options.fieldConfig] : [];
    this.groupDisplay = options.groupDisplay;
    this.headingLevel = options.headingLevel;
    this.visibleElements = options.visibleElements;
    this.validationFunction = options.validationFunction;
    this.expressionResult = evaluateStoredForm(this.formTemplate, this.feature);
    this.watchListeners = new Map();
    this.widgetHost = bindHonuaWidgetHost("honua-feature-editor", this.container, this.eventBus);
    this.pushWidgetHost();
  }

  public async load(): Promise<FeatureFormCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("feature-form.loading", undefined, this);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("feature-form.loaded", undefined, this);
    return this;
  }

  public async when(callback?: (widget: FeatureFormCompat) => void): Promise<FeatureFormCompat> {
    const widget = await this.load();
    if (callback) {
      callback(widget);
    }
    return widget;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): FeatureFormHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public setFeature(feature: unknown): void {
    this.feature = feature;
    this.expressionResult = evaluateStoredForm(this.formTemplate, this.feature);
    this.notifyWatchers("feature", this.feature);
    this.notifyWatchers("expressionResult", this.expressionResult);
    this.eventBus.emit("feature-form.feature-changed", { feature }, this);
    this.pushWidgetHost();
  }

  private pushWidgetHost(): void {
    pushWidgetHostState(this.widgetHost, {
      feature: this.feature,
      layer: this.layer,
      formTemplate: this.formTemplate,
      expressionResult: this.expressionResult,
    });
  }

  public async submit(values: Readonly<Record<string, unknown>> = {}): Promise<FeatureFormSubmitResultCompat> {
    const errors = this.validate(values);
    const result: FeatureFormSubmitResultCompat = {
      valid: errors.length === 0,
      values: { ...values },
      feature: this.feature,
      errors: errors.length > 0 ? errors : undefined,
    };
    if (errors.length > 0) {
      this.eventBus.emit("feature-form.validation-error", { errors, values }, this);
    }
    this.eventBus.emit("feature-form.submitted", result, this);
    return result;
  }

  /**
   * Runs validation against the provided values (or empty object)
   * and returns any field errors.
   */
  public validate(values: Readonly<Record<string, unknown>> = {}): readonly FeatureFormFieldErrorCompat[] {
    if (!this.validationFunction) {
      return [];
    }
    const errors: FeatureFormFieldErrorCompat[] = [];
    for (const [fieldName, value] of Object.entries(values)) {
      const error = this.validationFunction(fieldName, value);
      if (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /**
   * Returns the current feature's attribute values, merged with any
   * additional overrides. Useful for reading form state before submit.
   */
  public getValues(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
    const featureAttrs =
      typeof this.feature === "object" &&
      this.feature !== null &&
      "attributes" in this.feature &&
      typeof (this.feature as Record<string, unknown>).attributes === "object"
        ? { ...((this.feature as Record<string, unknown>).attributes as Record<string, unknown>) }
        : {};
    return { ...featureAttrs, ...overrides };
  }

  public on(eventName: string, listener: (event: unknown) => void): FeatureFormHandleCompat {
    const namespacedEvent = `feature-form.${eventName}`;
    const subscription = this.eventBus.on(namespacedEvent, (event) => {
      safeInvokeCompatListener(listener, event.payload);
    });

    return {
      remove: () => {
        subscription.remove();
      },
    };
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

function evaluateStoredForm(formTemplate: unknown, feature: unknown): FormExpressionResult {
  return evaluateFormExpressions(formFields(formTemplate), { attributes: featureAttributes(feature) });
}

function featureAttributes(feature: unknown): Record<string, unknown> {
  if (!feature || typeof feature !== "object") return {};
  const attributes = (feature as { attributes?: unknown }).attributes;
  return attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
}

function formFields(formTemplate: unknown): FormExpressionField[] {
  if (!formTemplate || typeof formTemplate !== "object") return [];
  const fields = (formTemplate as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((field) => {
    if (!field || typeof field !== "object") return [];
    const record = field as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.fieldName === "string"
          ? record.fieldName
          : undefined;
    if (!name) return [];
    return [
      {
        name,
        visibleExpression: expressionText(record.visibleExpression) ?? expressionText(record.visibilityExpression),
        valueExpression: expressionText(record.valueExpression) ?? expressionText(record.valueExpressionInfo),
      },
    ];
  });
}

function expressionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const expression = (value as { expression?: unknown }).expression;
  return typeof expression === "string" ? expression : undefined;
}
