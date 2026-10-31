import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { type HonuaWidgetHost, bindHonuaWidgetHost, pushWidgetHostState } from "./widget-host.js";

export interface PrintTemplateOptionsCompat {
  title?: string;
  format?: "pdf" | "png32" | "jpg";
  layout?: string;
  dpi?: number;
}

export interface PrintCompatOptions {
  view?: unknown;
  container?: unknown;
  eventBus?: CompatEventBus;
  printServiceUrl?: string;
  templateOptions?: PrintTemplateOptionsCompat;
}

export interface PrintExecuteOptionsCompat extends PrintTemplateOptionsCompat {}

export interface PrintResultCompat {
  url: string;
  title: string;
  format: string;
  layout: string;
  dpi: number;
}

export type PrintLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface PrintHandleCompat {
  remove(): void;
}

export class PrintCompat {
  public readonly view: unknown;
  public readonly container: unknown;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: PrintLoadStatusCompat;
  public printServiceUrl: string;
  public templateOptions: PrintTemplateOptionsCompat;
  public lastResult: PrintResultCompat | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;
  private readonly widgetHost: HonuaWidgetHost | undefined;

  public constructor(options: PrintCompatOptions = {}) {
    this.view = options.view;
    this.container = options.container;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.printServiceUrl = options.printServiceUrl ?? "https://example.test/print";
    this.templateOptions = { ...(options.templateOptions ?? {}) };
    this.lastResult = undefined;
    this.watchListeners = new Map();
    this.widgetHost = bindHonuaWidgetHost("honua-print-export", this.container, this.eventBus);
    this.pushWidgetHost();
  }

  public setFormat(format: PrintTemplateOptionsCompat["format"]): void {
    this.templateOptions = { ...this.templateOptions, format };
    this.notifyWatchers("templateOptions", this.templateOptions);
    this.pushWidgetHost();
  }

  public async load(): Promise<PrintCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("print.loading", undefined, this);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("print.loaded", undefined, this);
    return this;
  }

  public async when(callback?: (widget: PrintCompat) => void): Promise<PrintCompat> {
    const widget = await this.load();
    if (callback) {
      callback(widget);
    }
    return widget;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): PrintHandleCompat {
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

  public setTemplateOptions(nextOptions: PrintTemplateOptionsCompat): void {
    this.templateOptions = {
      ...this.templateOptions,
      ...nextOptions,
    };
    this.notifyWatchers("templateOptions", this.templateOptions);
    this.eventBus.emit("print.template-updated", { templateOptions: { ...this.templateOptions } }, this);
  }

  public async execute(options: PrintExecuteOptionsCompat = {}): Promise<PrintResultCompat> {
    const merged = {
      ...this.templateOptions,
      ...options,
    };
    const title = merged.title ?? "Map Export";
    const format = merged.format ?? "pdf";
    const layout = merged.layout ?? "a4-landscape";
    const dpi = merged.dpi ?? 96;
    this.eventBus.emit("print.execute-started", { title, format, layout, dpi }, this);

    const query = new URLSearchParams();
    query.set("title", title);
    query.set("format", format);
    query.set("layout", layout);
    query.set("dpi", String(dpi));
    const separator = this.printServiceUrl.includes("?") ? "&" : "?";
    const result: PrintResultCompat = {
      url: `${this.printServiceUrl}${separator}${query.toString()}`,
      title,
      format,
      layout,
      dpi,
    };
    this.lastResult = result;
    this.notifyWatchers("lastResult", this.lastResult);
    this.eventBus.emit("print.execute-completed", result, this);
    return result;
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private pushWidgetHost(): void {
    pushWidgetHostState(this.widgetHost, {
      view: this.view,
      format: this.templateOptions.format,
    });
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
