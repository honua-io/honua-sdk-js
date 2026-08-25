import type { Source } from "../contract/index.js";
import { type HonuaComponentRegistry, registerAllComponents } from "../controls/registry.js";
import type { QueryExecutionPlan } from "../query-planner/index.js";
import type { MaplibreMap } from "../runtime/index.js";

/** Version of the application-context snapshot and event contract. */
export const HONUA_APPLICATION_CONTEXT_VERSION = 1 as const;

/** Every state a supported application component can present. */
export type HonuaApplicationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "stale"
  | "degraded"
  | "unauthorized"
  | "unsupported"
  | "offline"
  | "failed";

export type HonuaApplicationDirection = "ltr" | "rtl" | "auto";
export type HonuaApplicationDiagnosticSeverity = "info" | "warning" | "error";

export interface HonuaApplicationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: HonuaApplicationDiagnosticSeverity;
  readonly componentId?: string;
  readonly status?: HonuaApplicationStatus;
}

export interface HonuaApplicationFreshness {
  readonly state: "current" | "stale" | "unknown";
  readonly observedAt?: string;
  readonly staleAfter?: string;
  readonly generation: number;
}

/** Credential-free authorization identity. Tokens and headers never belong here. */
export interface HonuaApplicationAuthorization {
  readonly status: "authorized" | "unauthorized" | "unknown";
  readonly principalId?: string;
  readonly scopes: readonly string[];
}

export interface HonuaApplicationTimeState {
  readonly start?: number;
  readonly end?: number;
  readonly current?: number;
}

export interface HonuaApplicationThemeTokens {
  readonly background?: string;
  readonly surface?: string;
  readonly foreground?: string;
  readonly muted?: string;
  readonly border?: string;
  readonly accent?: string;
  readonly accentForeground?: string;
  readonly danger?: string;
  readonly colorScheme?: "light" | "dark" | "light dark";
  readonly reducedMotion?: boolean;
}

export interface HonuaApplicationLocalePack {
  readonly locale: string;
  readonly direction?: HonuaApplicationDirection;
  readonly status?: Partial<Readonly<Record<HonuaApplicationStatus, string>>>;
  readonly number?: Intl.NumberFormatOptions;
  readonly date?: Intl.DateTimeFormatOptions;
  readonly unit?: Intl.NumberFormatOptions;
}

export interface HonuaApplicationBinding<T = Record<string, unknown>> {
  readonly source?: Source<T>;
  /** Stable, credential-free identity. Defaults to `source.descriptor.id`. */
  readonly sourceIdentity?: string;
  readonly plan?: QueryExecutionPlan;
  /** Stable identity for accepted plans. Defaults to the plan fingerprint. */
  readonly planIdentity?: string;
  readonly map?: MaplibreMap;
}

export interface HonuaApplicationContextSnapshot<T = Record<string, unknown>> {
  readonly version: typeof HONUA_APPLICATION_CONTEXT_VERSION;
  readonly revision: number;
  readonly invalidationGeneration: number;
  readonly status: HonuaApplicationStatus;
  readonly binding: HonuaApplicationBinding<T>;
  readonly viewport: Readonly<Record<string, unknown>> | undefined;
  readonly filters: readonly unknown[];
  readonly selection: readonly unknown[];
  readonly time: HonuaApplicationTimeState | undefined;
  readonly edits: readonly unknown[];
  readonly freshness: HonuaApplicationFreshness;
  readonly authorization: HonuaApplicationAuthorization;
  readonly diagnostics: readonly HonuaApplicationDiagnostic[];
  readonly locale: HonuaApplicationLocalePack;
  readonly theme: HonuaApplicationThemeTokens;
}

export interface HonuaApplicationContextUpdate<T = Record<string, unknown>> {
  readonly status?: HonuaApplicationStatus;
  readonly binding?: HonuaApplicationBinding<T>;
  readonly viewport?: Readonly<Record<string, unknown>> | undefined;
  readonly filters?: readonly unknown[];
  readonly selection?: readonly unknown[];
  readonly time?: HonuaApplicationTimeState | undefined;
  readonly edits?: readonly unknown[];
  readonly freshness?: Partial<HonuaApplicationFreshness>;
  readonly authorization?: HonuaApplicationAuthorization;
  readonly diagnostics?: readonly HonuaApplicationDiagnostic[];
  readonly locale?: HonuaApplicationLocalePack;
  readonly theme?: HonuaApplicationThemeTokens;
}

export type HonuaApplicationContextChangedKey = Exclude<keyof HonuaApplicationContextSnapshot, "version" | "revision">;

export interface HonuaApplicationContextChangeEvent<T = Record<string, unknown>> {
  readonly previous: HonuaApplicationContextSnapshot<T>;
  readonly current: HonuaApplicationContextSnapshot<T>;
  readonly changed: readonly HonuaApplicationContextChangedKey[];
  readonly reason: "update" | "source-replacement" | "authorization-replacement" | "invalidation" | "realtime";
}

export interface HonuaApplicationRealtimeDelta<T = Record<string, unknown>> {
  readonly sourceIdentity: string;
  readonly planIdentity?: string;
  readonly mode: "patch" | "invalidate";
  readonly update?: Omit<HonuaApplicationContextUpdate<T>, "binding" | "authorization">;
}

export interface HonuaApplicationStatusPresentation {
  readonly status: HonuaApplicationStatus;
  readonly label: string;
  readonly role: "status" | "alert";
  readonly ariaLive: "polite" | "assertive";
  readonly busy: boolean;
  readonly recoverable: boolean;
}

export interface CreateHonuaApplicationContextOptions<T = Record<string, unknown>>
  extends HonuaApplicationContextUpdate<T> {
  readonly onChange?: (event: HonuaApplicationContextChangeEvent<T>) => void;
}

export interface HonuaApplicationContext<T = Record<string, unknown>> {
  readonly version: typeof HONUA_APPLICATION_CONTEXT_VERSION;
  readonly disposed: boolean;
  readonly snapshot: HonuaApplicationContextSnapshot<T>;
  update(update: HonuaApplicationContextUpdate<T>): HonuaApplicationContextSnapshot<T>;
  replaceBinding(binding: HonuaApplicationBinding<T>): HonuaApplicationContextSnapshot<T>;
  replaceAuthorization(authorization: HonuaApplicationAuthorization): HonuaApplicationContextSnapshot<T>;
  invalidate(reason?: string): HonuaApplicationContextSnapshot<T>;
  applyRealtimeDelta(delta: HonuaApplicationRealtimeDelta<T>): boolean;
  reportDiagnostic(diagnostic: HonuaApplicationDiagnostic): HonuaApplicationContextSnapshot<T>;
  subscribe(listener: (event: HonuaApplicationContextChangeEvent<T>) => void): { remove(): void };
  runSharedRequest<TResult>(key: string, request: (signal: AbortSignal) => Promise<TResult>): Promise<TResult>;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  formatUnit(value: number, unit: Intl.NumberFormatOptions["unit"], options?: Intl.NumberFormatOptions): string;
  statusPresentation(status?: HonuaApplicationStatus): HonuaApplicationStatusPresentation;
  dispose(): void;
}

export interface HonuaApplicationContextParticipant<T = Record<string, unknown>> {
  applicationContext?: HonuaApplicationContext<T>;
  honuaApplicationContextConnected?(context: HonuaApplicationContext<T>): void;
  honuaApplicationContextChanged?(event: HonuaApplicationContextChangeEvent<T>): void;
  honuaApplicationContextDisconnected?(context: HonuaApplicationContext<T>): void;
}

export interface MountHonuaApplicationOptions<T = Record<string, unknown>> {
  readonly host: Element;
  readonly context?: HonuaApplicationContext<T>;
  readonly initial?: CreateHonuaApplicationContextOptions<T>;
  readonly registry?: HonuaComponentRegistry;
  /** Register the canonical component suite before mounting. @default true */
  readonly register?: boolean;
  /** Tokens applied after the context theme, allowing a mount-local override. */
  readonly theme?: HonuaApplicationThemeTokens;
}

export interface HonuaMountedApplication<T = Record<string, unknown>> {
  readonly host: Element;
  readonly context: HonuaApplicationContext<T>;
  readonly disposed: boolean;
  dispose(): void;
}

/** Public property, event, and disposal conventions shared by supported components. */
export const HONUA_APPLICATION_COMPONENT_CONVENTIONS = Object.freeze({
  contextProperty: "applicationContext",
  contextChangeEvent: "honua-application-context-change",
  statusChangeEvent: "honua-application-status-change",
  diagnosticEvent: "honua-application-diagnostic",
  connectedCallback: "honuaApplicationContextConnected",
  changedCallback: "honuaApplicationContextChanged",
  disconnectedCallback: "honuaApplicationContextDisconnected",
} as const);

const DEFAULT_STATUS_MESSAGES: Readonly<Record<HonuaApplicationStatus, string>> = Object.freeze({
  idle: "Waiting for application context",
  loading: "Loading",
  ready: "Ready",
  empty: "No results",
  stale: "Data may be out of date",
  degraded: "Some capabilities are unavailable",
  unauthorized: "Authorization is required",
  unsupported: "This capability is not supported",
  offline: "Offline",
  failed: "The operation failed",
});

const DEFAULT_LOCALE: HonuaApplicationLocalePack = Object.freeze({ locale: "en-US", direction: "ltr" });
const DEFAULT_AUTHORIZATION: HonuaApplicationAuthorization = Object.freeze({ status: "unknown", scopes: [] });
const DEFAULT_FRESHNESS: HonuaApplicationFreshness = Object.freeze({ state: "unknown", generation: 0 });

/** Maps a status to one consistent accessible presentation contract. */
export function presentHonuaApplicationStatus(
  status: HonuaApplicationStatus,
  locale: HonuaApplicationLocalePack = DEFAULT_LOCALE,
): HonuaApplicationStatusPresentation {
  const failed = status === "failed" || status === "unauthorized";
  return Object.freeze({
    status,
    label: locale.status?.[status] ?? DEFAULT_STATUS_MESSAGES[status],
    role: failed ? "alert" : "status",
    ariaLive: failed ? "assertive" : "polite",
    busy: status === "loading",
    recoverable: status === "stale" || status === "degraded" || status === "offline" || status === "failed",
  });
}

/**
 * Creates one application-scoped state owner. It coordinates invalidation and
 * in-flight work but deliberately does not retain result pages or create a
 * second persistent cache.
 */
export function createHonuaApplicationContext<T = Record<string, unknown>>(
  options: CreateHonuaApplicationContextOptions<T> = {},
): HonuaApplicationContext<T> {
  let disposed = false;
  let requestGeneration = 0;
  const listeners = new Set<(event: HonuaApplicationContextChangeEvent<T>) => void>();
  const pending = new Map<
    string,
    { readonly generation: number; readonly controller: AbortController; readonly promise: Promise<unknown> }
  >();
  let snapshot = initialSnapshot(options);

  const assertActive = (): void => {
    if (disposed) throw new Error("Honua application context is disposed.");
  };

  const cancelPending = (): void => {
    requestGeneration += 1;
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
  };

  const publish = (
    next: HonuaApplicationContextSnapshot<T>,
    changed: readonly HonuaApplicationContextChangedKey[],
    reason: HonuaApplicationContextChangeEvent<T>["reason"],
  ): HonuaApplicationContextSnapshot<T> => {
    const previous = snapshot;
    snapshot = freezeSnapshot(next);
    const event = Object.freeze({ previous, current: snapshot, changed: Object.freeze([...changed]), reason });
    options.onChange?.(event);
    for (const listener of [...listeners]) listener(event);
    return snapshot;
  };

  const apply = (
    update: HonuaApplicationContextUpdate<T>,
    reason: HonuaApplicationContextChangeEvent<T>["reason"],
  ): HonuaApplicationContextSnapshot<T> => {
    assertActive();
    const changed = changedKeys(snapshot, update);
    if (changed.length === 0) return snapshot;
    return publish(
      {
        ...snapshot,
        ...update,
        revision: snapshot.revision + 1,
        invalidationGeneration: update.freshness?.generation ?? snapshot.invalidationGeneration,
        binding: update.binding ? freezeBinding(update.binding) : snapshot.binding,
        filters: update.filters ? Object.freeze([...update.filters]) : snapshot.filters,
        selection: update.selection ? Object.freeze([...update.selection]) : snapshot.selection,
        edits: update.edits ? Object.freeze([...update.edits]) : snapshot.edits,
        diagnostics: update.diagnostics ? Object.freeze([...update.diagnostics]) : snapshot.diagnostics,
        authorization: update.authorization ? freezeAuthorization(update.authorization) : snapshot.authorization,
        freshness: update.freshness
          ? Object.freeze({ ...snapshot.freshness, ...update.freshness })
          : snapshot.freshness,
        locale: update.locale ? Object.freeze({ ...update.locale }) : snapshot.locale,
        theme: update.theme ? Object.freeze({ ...update.theme }) : snapshot.theme,
      },
      changed,
      reason,
    );
  };

  const context: HonuaApplicationContext<T> = {
    version: HONUA_APPLICATION_CONTEXT_VERSION,
    get disposed() {
      return disposed;
    },
    get snapshot() {
      return snapshot;
    },
    update(update) {
      return apply(update, "update");
    },
    replaceBinding(binding) {
      assertActive();
      cancelPending();
      const generation = snapshot.invalidationGeneration + 1;
      return apply(
        {
          binding,
          selection: [],
          edits: [],
          diagnostics: [],
          freshness: { state: "unknown", generation },
          status: binding.source || binding.plan || binding.map ? "loading" : "idle",
        },
        "source-replacement",
      );
    },
    replaceAuthorization(authorization) {
      assertActive();
      cancelPending();
      const generation = snapshot.invalidationGeneration + 1;
      return apply(
        {
          authorization,
          selection: [],
          edits: [],
          diagnostics: [],
          freshness: { state: "unknown", generation },
          status: authorization.status === "unauthorized" ? "unauthorized" : "loading",
        },
        "authorization-replacement",
      );
    },
    invalidate(reason) {
      assertActive();
      cancelPending();
      const diagnostic = reason
        ? [{ code: "application-context-invalidated", message: reason, severity: "info" as const }]
        : snapshot.diagnostics;
      return apply(
        {
          status: snapshot.authorization.status === "unauthorized" ? "unauthorized" : "stale",
          freshness: { state: "stale", generation: snapshot.invalidationGeneration + 1 },
          diagnostics: diagnostic,
        },
        "invalidation",
      );
    },
    applyRealtimeDelta(delta) {
      assertActive();
      const sourceIdentity = identityForSource(snapshot.binding);
      const planIdentity = identityForPlan(snapshot.binding);
      if (
        delta.sourceIdentity !== sourceIdentity ||
        (delta.planIdentity !== undefined && delta.planIdentity !== planIdentity)
      ) {
        return false;
      }
      if (delta.mode === "invalidate") {
        context.invalidate("Realtime data invalidated the active source or plan.");
      } else {
        apply(
          {
            ...delta.update,
            freshness: {
              ...delta.update?.freshness,
              state: delta.update?.freshness?.state ?? "current",
              generation: snapshot.invalidationGeneration,
            },
          },
          "realtime",
        );
      }
      return true;
    },
    reportDiagnostic(diagnostic) {
      return apply({ diagnostics: [...snapshot.diagnostics, Object.freeze({ ...diagnostic })] }, "update");
    },
    subscribe(listener) {
      assertActive();
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    runSharedRequest<TResult>(key: string, request: (signal: AbortSignal) => Promise<TResult>): Promise<TResult> {
      assertActive();
      const existing = pending.get(key);
      if (existing?.generation === requestGeneration) return existing.promise as Promise<TResult>;
      const controller = new AbortController();
      const generation = requestGeneration;
      const promise = Promise.resolve().then(() => request(controller.signal));
      pending.set(key, { generation, controller, promise });
      const release = (): void => {
        if (pending.get(key)?.promise === promise) pending.delete(key);
      };
      void promise.then(release, release);
      return promise;
    },
    formatNumber(value, formatOptions) {
      return new Intl.NumberFormat(snapshot.locale.locale, { ...snapshot.locale.number, ...formatOptions }).format(
        value,
      );
    },
    formatDate(value, formatOptions) {
      return new Intl.DateTimeFormat(snapshot.locale.locale, { ...snapshot.locale.date, ...formatOptions }).format(
        value instanceof Date ? value : new Date(value),
      );
    },
    formatUnit(value, unit, formatOptions) {
      return new Intl.NumberFormat(snapshot.locale.locale, {
        ...snapshot.locale.unit,
        ...formatOptions,
        style: "unit",
        unit,
      }).format(value);
    },
    statusPresentation(status = snapshot.status) {
      return presentHonuaApplicationStatus(status, snapshot.locale);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPending();
      listeners.clear();
    },
  };
  return context;
}

/** Registers the canonical suite from one explicit, idempotent call. */
export async function registerHonuaApplicationComponents(registry?: HonuaComponentRegistry): Promise<void> {
  await registerAllComponents(registry ? { registry } : {});
}

/**
 * Registers and mounts one context. Descendant Honua elements added later are
 * joined through one observer and disconnected deterministically on removal.
 */
export async function mountHonuaApplication<T = Record<string, unknown>>(
  options: MountHonuaApplicationOptions<T>,
): Promise<HonuaMountedApplication<T>> {
  if (options.register !== false) await registerHonuaApplicationComponents(options.registry);
  const context = options.context ?? createHonuaApplicationContext(options.initial);
  const ownsContext = options.context === undefined;
  const participants = new Set<HonuaApplicationContextParticipant<T>>();
  const originalPresentation = captureHostPresentation(options.host);
  let disposed = false;

  const connect = (candidate: Element): void => {
    if (!isParticipant<T>(candidate) || participants.has(candidate)) return;
    candidate.applicationContext = context;
    participants.add(candidate);
    candidate.honuaApplicationContextConnected?.(context);
  };
  const disconnect = (candidate: Element): void => {
    if (!isParticipant<T>(candidate) || !participants.delete(candidate)) return;
    candidate.honuaApplicationContextDisconnected?.(context);
    if (candidate.applicationContext === context) candidate.applicationContext = undefined;
  };
  const visit = (root: Element, callback: (candidate: Element) => void): void => {
    callback(root);
    for (const candidate of root.querySelectorAll("*")) callback(candidate);
  };

  visit(options.host, connect);
  applyHostPresentation(options.host, context.snapshot, options.theme);

  const observer =
    typeof globalThis.MutationObserver === "function"
      ? new globalThis.MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.removedNodes) if (isElementNode(node)) visit(node, disconnect);
            for (const node of record.addedNodes) if (isElementNode(node)) visit(node, connect);
          }
        })
      : undefined;
  observer?.observe(options.host, { childList: true, subtree: true });

  const subscription = context.subscribe((event) => {
    applyHostPresentation(options.host, event.current, options.theme);
    for (const participant of [...participants]) participant.honuaApplicationContextChanged?.(event);
    dispatchContextEvent(options.host, event);
    if (event.previous.status !== event.current.status) {
      dispatchCustomEvent(options.host, HONUA_APPLICATION_COMPONENT_CONVENTIONS.statusChangeEvent, {
        previous: event.previous.status,
        current: event.current.status,
        presentation: context.statusPresentation(),
      });
    }
    if (event.current.diagnostics.length > event.previous.diagnostics.length) {
      for (const diagnostic of event.current.diagnostics.slice(event.previous.diagnostics.length)) {
        dispatchCustomEvent(options.host, HONUA_APPLICATION_COMPONENT_CONVENTIONS.diagnosticEvent, diagnostic);
      }
    }
  });

  return {
    host: options.host,
    context,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      subscription.remove();
      visit(options.host, disconnect);
      restoreHostPresentation(options.host, originalPresentation);
      if (ownsContext) context.dispose();
    },
  };
}

function initialSnapshot<T>(options: CreateHonuaApplicationContextOptions<T>): HonuaApplicationContextSnapshot<T> {
  return freezeSnapshot({
    version: HONUA_APPLICATION_CONTEXT_VERSION,
    revision: 0,
    invalidationGeneration: options.freshness?.generation ?? 0,
    status: options.status ?? "idle",
    binding: freezeBinding(options.binding ?? {}),
    viewport: options.viewport,
    filters: Object.freeze([...(options.filters ?? [])]),
    selection: Object.freeze([...(options.selection ?? [])]),
    time: options.time,
    edits: Object.freeze([...(options.edits ?? [])]),
    freshness: Object.freeze({ ...DEFAULT_FRESHNESS, ...options.freshness }),
    authorization: freezeAuthorization(options.authorization ?? DEFAULT_AUTHORIZATION),
    diagnostics: Object.freeze([...(options.diagnostics ?? [])]),
    locale: Object.freeze({ ...DEFAULT_LOCALE, ...options.locale }),
    theme: Object.freeze({ ...(options.theme ?? {}) }),
  });
}

function freezeSnapshot<T>(snapshot: HonuaApplicationContextSnapshot<T>): HonuaApplicationContextSnapshot<T> {
  return Object.freeze(snapshot);
}

function freezeBinding<T>(binding: HonuaApplicationBinding<T>): HonuaApplicationBinding<T> {
  return Object.freeze({ ...binding });
}

function freezeAuthorization(authorization: HonuaApplicationAuthorization): HonuaApplicationAuthorization {
  return Object.freeze({ ...authorization, scopes: Object.freeze([...authorization.scopes].sort()) });
}

function identityForSource<T>(binding: HonuaApplicationBinding<T>): string | undefined {
  return binding.sourceIdentity ?? binding.source?.descriptor.id;
}

function identityForPlan<T>(binding: HonuaApplicationBinding<T>): string | undefined {
  return binding.planIdentity ?? binding.plan?.fingerprint;
}

function changedKeys<T>(
  snapshot: HonuaApplicationContextSnapshot<T>,
  update: HonuaApplicationContextUpdate<T>,
): HonuaApplicationContextChangedKey[] {
  const keys: HonuaApplicationContextChangedKey[] = [];
  for (const key of Object.keys(update) as (keyof HonuaApplicationContextUpdate<T>)[]) {
    if (key === "freshness") {
      keys.push("freshness", "invalidationGeneration");
    } else {
      keys.push(key);
    }
  }
  return [...new Set(keys)].filter((key) => key === "invalidationGeneration" || update[key] !== snapshot[key]);
}

function isParticipant<T>(candidate: Element): candidate is Element & HonuaApplicationContextParticipant<T> {
  return (
    candidate.localName.startsWith("honua-") || HONUA_APPLICATION_COMPONENT_CONVENTIONS.contextProperty in candidate
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

const THEME_PROPERTIES: Readonly<
  Record<Exclude<keyof HonuaApplicationThemeTokens, "colorScheme" | "reducedMotion">, string>
> = {
  background: "--honua-ui-bg",
  surface: "--honua-ui-surface",
  foreground: "--honua-ui-fg",
  muted: "--honua-ui-muted",
  border: "--honua-ui-border",
  accent: "--honua-ui-accent",
  accentForeground: "--honua-ui-accent-fg",
  danger: "--honua-ui-danger",
};

interface HostPresentationState {
  readonly lang: string | null;
  readonly dir: string | null;
  readonly status: string | null;
  readonly reducedMotion: boolean;
  readonly styles: Readonly<Record<string, string>>;
}

function captureHostPresentation(host: Element): HostPresentationState {
  const properties = [...Object.values(THEME_PROPERTIES), "color-scheme"];
  const style = "style" in host ? (host as HTMLElement).style : undefined;
  return {
    lang: host.getAttribute("lang"),
    dir: host.getAttribute("dir"),
    status: host.getAttribute("data-honua-status"),
    reducedMotion: host.hasAttribute("data-honua-reduced-motion"),
    styles: Object.freeze(
      Object.fromEntries(properties.map((property) => [property, style?.getPropertyValue(property) ?? ""])),
    ),
  };
}

function applyHostPresentation<T>(
  host: Element,
  snapshot: HonuaApplicationContextSnapshot<T>,
  override: HonuaApplicationThemeTokens | undefined,
): void {
  const locale = snapshot.locale;
  host.setAttribute("lang", locale.locale);
  host.setAttribute("dir", locale.direction ?? "auto");
  host.setAttribute("data-honua-status", snapshot.status);
  const theme = { ...snapshot.theme, ...override };
  if (!("style" in host)) return;
  const style = (host as HTMLElement).style;
  for (const [key, property] of Object.entries(THEME_PROPERTIES) as [keyof typeof THEME_PROPERTIES, string][]) {
    const value = theme[key];
    if (value === undefined) style.removeProperty(property);
    else style.setProperty(property, value);
  }
  if (theme.colorScheme === undefined) style.removeProperty("color-scheme");
  else style.setProperty("color-scheme", theme.colorScheme);
  host.toggleAttribute("data-honua-reduced-motion", theme.reducedMotion === true);
}

function restoreHostPresentation(host: Element, original: HostPresentationState): void {
  restoreAttribute(host, "lang", original.lang);
  restoreAttribute(host, "dir", original.dir);
  restoreAttribute(host, "data-honua-status", original.status);
  host.toggleAttribute("data-honua-reduced-motion", original.reducedMotion);
  if (!("style" in host)) return;
  const style = (host as HTMLElement).style;
  for (const [property, value] of Object.entries(original.styles)) {
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
  }
}

function restoreAttribute(host: Element, name: string, value: string | null): void {
  if (value === null) host.removeAttribute(name);
  else host.setAttribute(name, value);
}

function dispatchContextEvent<T>(host: Element, event: HonuaApplicationContextChangeEvent<T>): void {
  dispatchCustomEvent(host, HONUA_APPLICATION_COMPONENT_CONVENTIONS.contextChangeEvent, event);
}

function dispatchCustomEvent(host: Element, name: string, detail: unknown): void {
  const ownerWindow = host.ownerDocument?.defaultView;
  const EventConstructor = ownerWindow?.CustomEvent ?? globalThis.CustomEvent;
  if (typeof EventConstructor !== "function") return;
  host.dispatchEvent(new EventConstructor(name, { bubbles: true, composed: true, detail }));
}
