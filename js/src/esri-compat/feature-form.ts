import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface FeatureFormCompatOptions {
  view?: unknown;
  layer?: unknown;
  container?: unknown;
  feature?: unknown;
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

export type FeatureFormValidationFn = (
  fieldName: string,
  value: unknown,
) => FeatureFormFieldErrorCompat | undefined;

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
  public fieldConfig: readonly unknown[];
  public groupDisplay: string | undefined;
  public headingLevel: number | undefined;
  public visibleElements: unknown;
  public validationFunction: FeatureFormValidationFn | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: FeatureFormCompatOptions = {}) {
    this.view = options.view;
    this.layer = options.layer;
    this.container = options.container;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view, options.layer) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.feature = options.feature;
    this.fieldConfig = options.fieldConfig ? [...options.fieldConfig] : [];
    this.groupDisplay = options.groupDisplay;
    this.headingLevel = options.headingLevel;
    this.visibleElements = options.visibleElements;
    this.validationFunction = options.validationFunction;
    this.watchListeners = new Map();
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
    this.notifyWatchers("feature", this.feature);
    this.eventBus.emit("feature-form.feature-changed", { feature }, this);
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
  public validate(
    values: Readonly<Record<string, unknown>> = {},
  ): readonly FeatureFormFieldErrorCompat[] {
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
