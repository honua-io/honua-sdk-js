import { createHonuaWebComponentController } from "./controller.js";
import type {
  CreateHonuaWebComponentControllerOptions,
  HonuaChartModel,
  HonuaControllerReadyDetail,
  HonuaEditChangeDetail,
  HonuaEditorModel,
  HonuaFeatureRecord,
  HonuaFeatureTableModel,
  HonuaFilterChangeDetail,
  HonuaLayerVisibilityChangeDetail,
  HonuaSearchDetail,
  HonuaSearchResult,
  HonuaSelectionChangeDetail,
  HonuaViewportChangeDetail,
  HonuaWebComponentController,
  HonuaWebComponentState,
} from "./types.js";

const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  CustomEvent?: typeof CustomEvent;
  customElements?: CustomElementRegistry;
};

const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

abstract class HonuaElementBase<T = Record<string, unknown>> extends HTMLElementBase {
  #controller: HonuaWebComponentController<T> | undefined;
  #unsubscribe: { remove(): void } | undefined;
  #controllerReadyListener: ((event: Event) => void) | undefined;
  protected state: HonuaWebComponentState<T> | undefined;

  public get controller(): HonuaWebComponentController<T> | undefined {
    return this.#controller;
  }

  public set controller(controller: HonuaWebComponentController<T> | undefined) {
    if (this.#controller === controller) return;
    this.#unsubscribe?.remove();
    this.#unsubscribe = undefined;
    this.#controller = controller;
    this.state = controller?.getState();
    if (controller) {
      this.#unsubscribe = controller.subscribe((state) => {
        this.state = state;
        this.stateChanged(state);
        this.render();
      });
    }
    this.controllerChanged(controller);
    this.render();
  }

  public connectedCallback(): void {
    this.ensureShadowRoot();
    this.listenForControllerReady();
    this.resolveControllerFromContext();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#unsubscribe?.remove();
    this.#unsubscribe = undefined;
    if (this.#controllerReadyListener) {
      this.getRootEventTarget()?.removeEventListener("honua-controller-ready", this.#controllerReadyListener);
      this.#controllerReadyListener = undefined;
    }
  }

  protected controllerChanged(_controller: HonuaWebComponentController<T> | undefined): void {}

  protected stateChanged(_state: HonuaWebComponentState<T>): void {}

  protected ensureShadowRoot(): void {
    if (!this.shadowRoot && typeof this.attachShadow === "function") {
      this.attachShadow({ mode: "open" });
    }
  }

  protected setShadowHtml(html: string): void {
    this.ensureShadowRoot();
    const root = this.shadowRoot ?? this;
    root.innerHTML = html;
  }

  protected resolveControllerFromContext(): void {
    if (this.controller) return;
    const mapId = this.getAttribute("for");
    const root = this.getRootNode?.() as (Document | ShadowRoot) | undefined;
    const map = mapId
      ? getElementById(root, mapId)
      : typeof root?.querySelector === "function"
        ? root.querySelector("honua-map")
        : undefined;
    const controller = (map as { controller?: HonuaWebComponentController<T> } | undefined)?.controller;
    if (controller) this.controller = controller;
  }

  protected listenForControllerReady(): void {
    if (this.#controllerReadyListener) return;
    const target = this.getRootEventTarget();
    if (!target) return;
    this.#controllerReadyListener = (event: Event) => {
      const detail = (event as CustomEvent<HonuaControllerReadyDetail<T>>).detail;
      if (!detail?.controller) return;
      const mapId = this.getAttribute("for");
      if (mapId && (event.target as Element | null)?.id !== mapId) return;
      if (!mapId && this.controller) return;
      this.controller = detail.controller;
    };
    target.addEventListener("honua-controller-ready", this.#controllerReadyListener as EventListener);
  }

  protected dispatchTypedEvent<D>(name: string, detail: D): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    this.dispatchEvent(new globalDom.CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  protected getRootEventTarget(): EventTarget | undefined {
    const root = this.getRootNode?.();
    if (root && "addEventListener" in root) return root as EventTarget;
    return typeof document !== "undefined" ? document : undefined;
  }

  protected abstract render(): void;
}

export class HonuaMapElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["map-package", "label"];
  }

  #options: CreateHonuaWebComponentControllerOptions<T> = {};

  public get mapPackage(): CreateHonuaWebComponentControllerOptions<T>["mapPackage"] {
    return this.#options.mapPackage;
  }

  public set mapPackage(mapPackage: CreateHonuaWebComponentControllerOptions<T>["mapPackage"]) {
    this.#options = { ...this.#options, ...(mapPackage ? { mapPackage } : { mapPackage: undefined }) };
    if (!this.controller) this.ensureController();
    this.render();
  }

  public get featuresBySource(): CreateHonuaWebComponentControllerOptions<T>["featuresBySource"] {
    return this.#options.featuresBySource;
  }

  public set featuresBySource(featuresBySource: CreateHonuaWebComponentControllerOptions<T>["featuresBySource"]) {
    this.#options = {
      ...this.#options,
      ...(featuresBySource ? { featuresBySource } : { featuresBySource: undefined }),
    };
    if (this.controller?.updateFeatures && featuresBySource) {
      for (const [sourceId, features] of Object.entries(featuresBySource)) {
        this.controller.updateFeatures(sourceId, features as readonly HonuaFeatureRecord<T>[]);
      }
    } else if (!this.controller) {
      this.ensureController();
    }
    this.render();
  }

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "map-package" && newValue) {
      try {
        this.mapPackage = JSON.parse(newValue) as CreateHonuaWebComponentControllerOptions<T>["mapPackage"];
      } catch {
        // Invalid inline JSON is surfaced visually by the empty component state.
      }
    }
    this.render();
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this.ensureController();
  }

  protected controllerChanged(controller: HonuaWebComponentController<T> | undefined): void {
    if (controller) {
      this.dispatchTypedEvent<HonuaControllerReadyDetail<T>>("honua-controller-ready", { controller });
    }
  }

  protected render(): void {
    const state = this.state ?? this.controller?.getState();
    const layers = state?.layers ?? [];
    const viewport = state?.viewport ?? {};
    const visibleLayers = layers.filter((layer) => layer.visible);
    const label = this.getAttribute("label") ?? state?.mapPackage?.mapPackageId ?? "Honua map";
    this.setShadowHtml(`
      <style>${baseStyles()}${mapStyles()}</style>
      <section part="map" class="map" role="region" aria-label="${escapeHtml(label)}" tabindex="0">
        <div class="map__chrome">
          <div class="map__title">${escapeHtml(label)}</div>
          <div class="map__controls" aria-label="Map controls">
            <button type="button" class="icon-button" data-zoom="out" aria-label="Zoom out">-</button>
            <output class="zoom" aria-label="Zoom">${escapeHtml(String(viewport.zoom ?? 0))}</output>
            <button type="button" class="icon-button" data-zoom="in" aria-label="Zoom in">+</button>
          </div>
        </div>
        <div class="map__canvas" part="canvas">
          ${visibleLayers.map((layer, index) => layerBackdrop(layer.title, index, visibleLayers.length)).join("")}
        </div>
        <div class="map__footer">
          <span>${escapeHtml(String(visibleLayers.length))} visible</span>
          <span>${viewport.center ? escapeHtml(viewport.center.join(", ")) : "No center"}</span>
        </div>
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((button) => {
      button.addEventListener("click", () => {
        const direction = button.dataset.zoom === "in" ? 1 : -1;
        const nextZoom = (this.controller?.getState().viewport.zoom ?? 0) + direction;
        this.controller?.setViewport({ zoom: nextZoom });
        this.dispatchTypedEvent<HonuaViewportChangeDetail>("honua-viewport-change", { zoom: nextZoom });
      });
    });
  }

  private ensureController(): void {
    if (this.controller) return;
    this.controller = createHonuaWebComponentController(this.#options);
  }
}

export class HonuaLayerListElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const layers = this.state?.layers ?? [];
    const label = this.getAttribute("label") ?? "Layers";
    this.setShadowHtml(`
      <style>${baseStyles()}${listStyles()}</style>
      <fieldset class="panel" part="panel">
        <legend>${escapeHtml(label)}</legend>
        <div class="stack" role="list">
          ${
            layers.length === 0
              ? `<p class="empty">No layers</p>`
              : layers
                  .map(
                    (layer) => `
            <label class="check-row" role="listitem">
              <input type="checkbox" data-layer-id="${escapeHtml(layer.id)}" ${layer.visible ? "checked" : ""} />
              <span>${escapeHtml(layer.title)}</span>
            </label>
          `,
                  )
                  .join("")
          }
        </div>
      </fieldset>
    `);
    this.shadowRoot?.querySelectorAll<HTMLInputElement>("input[data-layer-id]").forEach((input) => {
      input.addEventListener("change", () => {
        const layerId = input.dataset.layerId;
        if (!layerId) return;
        this.controller?.setLayerVisibility(layerId, input.checked);
        this.dispatchTypedEvent<HonuaLayerVisibilityChangeDetail>("honua-layer-visibility-change", {
          layerId,
          visible: input.checked,
        });
      });
    });
  }
}

export class HonuaLegendElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const legend = this.state?.legend ?? [];
    const label = this.getAttribute("label") ?? "Legend";
    this.setShadowHtml(`
      <style>${baseStyles()}${listStyles()}</style>
      <section class="panel" part="panel" aria-label="${escapeHtml(label)}">
        <h2>${escapeHtml(label)}</h2>
        <ul class="legend">
          ${
            legend.length === 0
              ? `<li class="empty">No legend</li>`
              : legend
                  .map(
                    (item) => `
            <li>
              ${
                item.iconUrl
                  ? `<img class="swatch" alt="" src="${escapeAttribute(item.iconUrl)}" />`
                  : `<span class="swatch" style="--swatch:${escapeAttribute(item.color ?? "#64748b")}"></span>`
              }
              <span>${escapeHtml(item.label)}</span>
            </li>
          `,
                  )
                  .join("")
          }
        </ul>
      </section>
    `);
  }
}

export class HonuaFeatureTableElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "source", "fields", "page-size", "filter-text", "label"];
  }

  #model: HonuaFeatureTableModel<T> | undefined;
  #refreshToken = 0;

  public attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    this.resolveControllerFromContext();
    if (name === "filter-text") {
      const detail: HonuaFilterChangeDetail = {
        sourceId: this.sourceId(),
        text: newValue ?? "",
      };
      this.controller?.setFilter(detail);
      this.dispatchTypedEvent<HonuaFilterChangeDetail>("honua-filter-change", detail);
    }
    void this.refresh();
  }

  public connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  protected stateChanged(): void {
    void this.refresh();
  }

  public async refresh(): Promise<HonuaFeatureTableModel<T> | undefined> {
    const controller = this.controller;
    if (!controller) return undefined;
    const token = ++this.#refreshToken;
    const model = await controller.queryFeatures(this.sourceId(), {
      fields: this.fields(),
      pagination: { limit: this.pageSize() },
    });
    if (token !== this.#refreshToken) return this.#model;
    this.#model = model;
    this.render();
    return model;
  }

  protected render(): void {
    const state = this.state;
    const model = this.#model ?? tableModelFromState(state, this.sourceId(), this.fields(), this.pageSize());
    const selectedId = state?.selection?.featureId;
    const label = this.getAttribute("label") ?? "Features";
    this.setShadowHtml(`
      <style>${baseStyles()}${tableStyles()}</style>
      <section class="table-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="table-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(String(model.totalCount))}</span>
        </div>
        <div class="table-wrap">
          <table role="grid" aria-rowcount="${escapeHtml(String(model.rows.length))}">
            <thead>
              <tr>${model.fields.map((field) => `<th scope="col">${escapeHtml(field)}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${
                model.rows.length === 0
                  ? `<tr><td colspan="${Math.max(1, model.fields.length)}" class="empty">No rows</td></tr>`
                  : model.rows
                      .map(
                        (row) => `
                <tr tabindex="0" data-source-id="${escapeHtml(row.sourceId)}" data-feature-id="${escapeHtml(
                  String(row.id),
                )}" aria-selected="${String(String(selectedId ?? "") === String(row.id))}">
                  ${model.fields.map((field) => `<td>${escapeHtml(formatCell((row.attributes as Record<string, unknown>)[field]))}</td>`).join("")}
                </tr>
              `,
                      )
                      .join("")
              }
            </tbody>
          </table>
        </div>
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-feature-id]").forEach((row) => {
      const select = () => this.selectRow(row);
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
    });
  }

  private selectRow(row: HTMLTableRowElement): void {
    const sourceId = row.dataset.sourceId;
    const featureId = row.dataset.featureId;
    if (!sourceId || featureId === undefined) return;
    const feature = (this.#model?.rows ?? []).find((candidate) => String(candidate.id) === featureId);
    this.controller?.selectFeature({ sourceId, featureId, ...(feature ? { feature } : {}) });
    this.dispatchTypedEvent<HonuaSelectionChangeDetail<T>>("honua-selection-change", {
      sourceId,
      featureId,
      ...(feature ? { feature } : {}),
    });
  }

  private sourceId(): string | undefined {
    return this.getAttribute("source") ?? undefined;
  }

  private fields(): readonly string[] | undefined {
    const value = this.getAttribute("fields");
    return value
      ?.split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }

  private pageSize(): number | undefined {
    const parsed = Number(this.getAttribute("page-size"));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}

export class HonuaSearchElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "source", "placeholder", "label"];
  }

  #query = "";
  #results: readonly HonuaSearchResult<T>[] = [];

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Search";
    const placeholder = this.getAttribute("placeholder") ?? "Search";
    this.setShadowHtml(`
      <style>${baseStyles()}${searchStyles()}</style>
      <section class="search" part="panel" aria-label="${escapeHtml(label)}">
        <form>
          <label class="sr-only" for="honua-search-input">${escapeHtml(label)}</label>
          <input id="honua-search-input" name="q" value="${escapeAttribute(this.#query)}" placeholder="${escapeAttribute(
            placeholder,
          )}" autocomplete="off" />
          <button type="submit">Search</button>
        </form>
        <ul class="results" aria-live="polite">
          ${this.#results.map((result) => `<li><button type="button" data-result-id="${escapeHtml(result.id)}">${escapeHtml(result.label)}</button></li>`).join("")}
        </ul>
      </section>
    `);
    this.shadowRoot?.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.shadowRoot?.querySelector<HTMLInputElement>("input[name='q']");
      void this.runSearch(input?.value ?? "");
    });
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-result-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const result = this.#results.find((candidate) => candidate.id === button.dataset.resultId);
        if (!result?.featureId || !result.sourceId) return;
        this.controller?.selectFeature({
          sourceId: result.sourceId,
          featureId: result.featureId,
          ...(result.feature ? { feature: result.feature } : {}),
        });
        this.dispatchTypedEvent<HonuaSelectionChangeDetail<T>>("honua-selection-change", {
          sourceId: result.sourceId,
          featureId: result.featureId,
          ...(result.feature ? { feature: result.feature } : {}),
        });
      });
    });
  }

  private async runSearch(query: string): Promise<void> {
    this.#query = query;
    const sourceId = this.getAttribute("source") ?? undefined;
    this.#results = await (this.controller?.search(query, { sourceId }) ?? []);
    this.dispatchTypedEvent<HonuaSearchDetail<T>>("honua-search", { query, results: this.#results });
    this.render();
  }
}

export class HonuaEditorElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "source", "label"];
  }

  #model: HonuaEditorModel | undefined;

  public get editorModel(): HonuaEditorModel | undefined {
    return this.#model ?? this.state?.editor;
  }

  public set editorModel(model: HonuaEditorModel | undefined) {
    this.#model = model;
    this.render();
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const state = this.state;
    const model = this.#model ?? state?.editor ?? defaultEditorModel(this.getAttribute("source") ?? undefined);
    const selected = state?.selection?.feature;
    const canUpdate = model.capabilities.canUpdate && !model.capabilities.readOnly;
    const label = this.getAttribute("label") ?? "Editor";
    this.setShadowHtml(`
      <style>${baseStyles()}${editorStyles()}</style>
      <section class="editor" part="panel" aria-label="${escapeHtml(label)}">
        <div class="editor__bar">
          <h2>${escapeHtml(label)}</h2>
          <span data-status>${escapeHtml(model.status)}</span>
        </div>
        <p class="selection">${escapeHtml(selected?.title ?? "No selection")}</p>
        <p class="muted">${escapeHtml(model.capabilities.readOnly ? (model.capabilities.reason ?? "Read-only") : "Editable")}</p>
        <div class="editor__actions">
          <button type="button" data-action="new" ${model.capabilities.canCreate && !model.capabilities.readOnly ? "" : "disabled"}>New</button>
          <button type="button" data-action="save" ${canUpdate ? "" : "disabled"}>Save</button>
          <button type="button" data-action="delete" ${model.capabilities.canDelete && !model.capabilities.readOnly ? "" : "disabled"}>Delete</button>
        </div>
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        void this.runEdit(button.dataset.action ?? "update", model);
      });
    });
  }

  private async runEdit(action: string, model: HonuaEditorModel): Promise<void> {
    const feature = this.state?.selection?.feature;
    const sourceId = this.getAttribute("source") ?? model.sourceId ?? feature?.sourceId;
    if (!feature || !sourceId) return;
    const operation = action === "new" ? "create" : action === "delete" ? "delete" : "update";
    const request = { sourceId, feature, operation } as const;
    const next = await (this.controller?.applyEdit?.(request) ??
      Promise.resolve({ ...model, status: "unsupported" as const }));
    this.#model = next;
    this.dispatchTypedEvent<HonuaEditChangeDetail<T>>("honua-edit-change", {
      status: next.status,
      request,
      model: next,
    });
    this.render();
  }
}

export class HonuaChartElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #model: HonuaChartModel | undefined;

  public get chartModel(): HonuaChartModel | undefined {
    return this.#model ?? this.state?.chart;
  }

  public set chartModel(model: HonuaChartModel | undefined) {
    this.#model = model;
    this.render();
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const model = this.chartModel ?? defaultChartModel(this.getAttribute("label") ?? "Chart");
    const max = Math.max(1, ...(model.data ?? []).map((datum) => datum.value));
    this.setShadowHtml(`
      <style>${baseStyles()}${chartStyles()}</style>
      <section class="chart" part="panel" aria-label="${escapeHtml(model.title)}">
        <h2>${escapeHtml(model.title)}</h2>
        <div class="bars">
          ${
            model.data?.length
              ? model.data
                  .map(
                    (datum) => `
            <div class="bar-row">
              <span>${escapeHtml(datum.label)}</span>
              <span class="bar" style="--bar:${(datum.value / max) * 100}%;--bar-color:${escapeAttribute(
                datum.color ?? "#2563eb",
              )}"></span>
              <strong>${escapeHtml(String(datum.value))}</strong>
            </div>
          `,
                  )
                  .join("")
              : `<p class="empty">${escapeHtml(model.message ?? "No chart data")}</p>`
          }
        </div>
      </section>
    `);
  }
}

export function defineHonuaWebComponents(registry = globalDom.customElements): void {
  if (!registry) return;
  defineIfMissing(registry, "honua-map", HonuaMapElement);
  defineIfMissing(registry, "honua-layer-list", HonuaLayerListElement);
  defineIfMissing(registry, "honua-legend", HonuaLegendElement);
  defineIfMissing(registry, "honua-feature-table", HonuaFeatureTableElement);
  defineIfMissing(registry, "honua-search", HonuaSearchElement);
  defineIfMissing(registry, "honua-editor", HonuaEditorElement);
  defineIfMissing(registry, "honua-chart", HonuaChartElement);
}

function defineIfMissing(registry: CustomElementRegistry, tagName: string, ctor: CustomElementConstructor): void {
  if (!registry.get(tagName)) registry.define(tagName, ctor);
}

if (globalDom.customElements) {
  defineHonuaWebComponents(globalDom.customElements);
}

function tableModelFromState<T>(
  state: HonuaWebComponentState<T> | undefined,
  sourceId: string | undefined,
  fields: readonly string[] | undefined,
  pageSize: number | undefined,
): HonuaFeatureTableModel<T> {
  const resolvedSourceId = sourceId ?? Object.keys(state?.featuresBySource ?? {})[0];
  const rows = resolvedSourceId ? [...(state?.featuresBySource[resolvedSourceId] ?? [])] : [];
  const modelFields = fields ?? inferFields(rows);
  return {
    sourceId: resolvedSourceId,
    status: state?.status ?? "idle",
    fields: modelFields,
    rows: pageSize ? rows.slice(0, pageSize) : rows,
    totalCount: rows.length,
  };
}

function defaultEditorModel(sourceId: string | undefined): HonuaEditorModel {
  return {
    sourceId,
    status: "idle",
    capabilities: {
      canCreate: false,
      canUpdate: false,
      canDelete: false,
      readOnly: true,
      reason: "Editing is not enabled for this source.",
    },
  };
}

function defaultChartModel(title: string): HonuaChartModel {
  return {
    id: "placeholder",
    title,
    kind: "placeholder",
    status: "idle",
    message: "No chart data",
  };
}

function inferFields<T>(rows: readonly HonuaFeatureRecord<T>[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row.attributes as Record<string, unknown>)) fields.add(field);
  }
  return [...fields];
}

function getElementById(root: Document | ShadowRoot | undefined, id: string): Element | null {
  if (root && "getElementById" in root) return root.getElementById(id);
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

function layerBackdrop(title: string, index: number, total: number): string {
  const top = 18 + index * 12;
  const height = Math.max(18, 72 - total * 4);
  return `<div class="layer-plane" style="--top:${top}px;--height:${height}px;--shade:${index}" aria-hidden="true"></div><span class="layer-label" style="--top:${
    top + height + 4
  }px">${escapeHtml(title)}</span>`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function baseStyles(): string {
  return `
    :host {
      --honua-ui-bg: #ffffff;
      --honua-ui-fg: #172033;
      --honua-ui-muted: #667085;
      --honua-ui-border: #d0d5dd;
      --honua-ui-accent: #1d4ed8;
      --honua-ui-accent-fg: #ffffff;
      --honua-ui-surface: #f8fafc;
      box-sizing: border-box;
      color: var(--honua-ui-fg);
      display: block;
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    *, *::before, *::after { box-sizing: inherit; }
    button, input, select { font: inherit; }
    button {
      border: 1px solid var(--honua-ui-border);
      background: var(--honua-ui-bg);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      min-height: 32px;
      padding: 0 10px;
    }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    h2 { font-size: 14px; margin: 0; }
    .empty, .muted { color: var(--honua-ui-muted); }
    .sr-only {
      border: 0;
      clip: rect(0 0 0 0);
      height: 1px;
      margin: -1px;
      overflow: hidden;
      padding: 0;
      position: absolute;
      width: 1px;
    }
  `;
}

function mapStyles(): string {
  return `
    .map {
      background: #dbeafe;
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: grid;
      grid-template-rows: auto minmax(220px, 1fr) auto;
      min-height: 320px;
      overflow: hidden;
    }
    .map__chrome, .map__footer {
      align-items: center;
      background: rgba(255, 255, 255, 0.9);
      display: flex;
      gap: 8px;
      justify-content: space-between;
      padding: 8px 10px;
    }
    .map__controls { align-items: center; display: flex; gap: 6px; }
    .icon-button { min-width: 32px; padding: 0; }
    .zoom { min-width: 32px; text-align: center; }
    .map__canvas {
      background:
        linear-gradient(90deg, rgba(255,255,255,0.32) 1px, transparent 1px),
        linear-gradient(0deg, rgba(255,255,255,0.32) 1px, transparent 1px),
        #bfdbfe;
      background-size: 40px 40px;
      min-height: 220px;
      position: relative;
    }
    .layer-plane {
      background: color-mix(in srgb, #2563eb calc(25% + var(--shade) * 10%), #16a34a);
      border: 1px solid rgba(15, 23, 42, 0.18);
      border-radius: 8px;
      height: var(--height);
      left: calc(18px + var(--shade) * 24px);
      opacity: 0.74;
      position: absolute;
      right: calc(24px + var(--shade) * 18px);
      top: var(--top);
    }
    .layer-label {
      background: rgba(255,255,255,0.82);
      border-radius: 4px;
      left: calc(22px + var(--shade, 0) * 24px);
      padding: 2px 6px;
      position: absolute;
      top: var(--top);
    }
  `;
}

function listStyles(): string {
  return `
    .panel {
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      margin: 0;
      padding: 10px;
    }
    legend { font-weight: 650; padding: 0 4px; }
    .stack { display: grid; gap: 8px; }
    .check-row { align-items: center; display: flex; gap: 8px; min-height: 28px; }
    .legend { display: grid; gap: 8px; list-style: none; margin: 10px 0 0; padding: 0; }
    .legend li { align-items: center; display: flex; gap: 8px; min-height: 24px; }
    .swatch {
      background: var(--swatch);
      border: 1px solid rgba(15, 23, 42, 0.18);
      border-radius: 3px;
      display: inline-block;
      height: 16px;
      width: 24px;
    }
    img.swatch { object-fit: cover; }
  `;
}

function tableStyles(): string {
  return `
    .table-panel {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      overflow: hidden;
    }
    .table-panel__bar {
      align-items: center;
      background: var(--honua-ui-surface);
      display: flex;
      justify-content: space-between;
      padding: 8px 10px;
    }
    .table-wrap { max-height: 300px; overflow: auto; }
    table { border-collapse: collapse; min-width: 100%; table-layout: fixed; }
    th, td {
      border-top: 1px solid var(--honua-ui-border);
      overflow: hidden;
      padding: 7px 9px;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th { background: #f8fafc; font-weight: 650; }
    tr[aria-selected="true"] td { background: #dbeafe; }
    tbody tr[data-feature-id] { cursor: pointer; }
    tbody tr[data-feature-id]:focus { outline: 2px solid var(--honua-ui-accent); outline-offset: -2px; }
  `;
}

function searchStyles(): string {
  return `
    .search {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      padding: 10px;
    }
    form { display: grid; gap: 8px; grid-template-columns: minmax(120px, 1fr) auto; }
    input {
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      min-height: 32px;
      min-width: 0;
      padding: 0 9px;
    }
    .results { display: grid; gap: 6px; list-style: none; margin: 10px 0 0; padding: 0; }
    .results button { text-align: left; width: 100%; }
  `;
}

function editorStyles(): string {
  return `
    .editor {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      padding: 10px;
    }
    .editor__bar, .editor__actions { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .editor__actions { justify-content: flex-start; }
    .selection { margin: 10px 0 4px; }
    .muted { margin: 0 0 10px; }
  `;
}

function chartStyles(): string {
  return `
    .chart {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      padding: 10px;
    }
    .bars { display: grid; gap: 8px; margin-top: 10px; }
    .bar-row { align-items: center; display: grid; gap: 8px; grid-template-columns: minmax(70px, 1fr) 3fr auto; }
    .bar { background: #e5e7eb; border-radius: 999px; height: 10px; overflow: hidden; position: relative; }
    .bar::before {
      background: var(--bar-color);
      border-radius: inherit;
      content: "";
      inset: 0 auto 0 0;
      position: absolute;
      width: var(--bar);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "honua-map": HonuaMapElement;
    "honua-layer-list": HonuaLayerListElement;
    "honua-legend": HonuaLegendElement;
    "honua-feature-table": HonuaFeatureTableElement;
    "honua-search": HonuaSearchElement;
    "honua-editor": HonuaEditorElement;
    "honua-chart": HonuaChartElement;
  }

  interface HTMLElementEventMap {
    "honua-controller-ready": CustomEvent<HonuaControllerReadyDetail>;
    "honua-layer-visibility-change": CustomEvent<HonuaLayerVisibilityChangeDetail>;
    "honua-selection-change": CustomEvent<HonuaSelectionChangeDetail>;
    "honua-viewport-change": CustomEvent<HonuaViewportChangeDetail>;
    "honua-filter-change": CustomEvent<HonuaFilterChangeDetail>;
    "honua-search": CustomEvent<HonuaSearchDetail>;
    "honua-edit-change": CustomEvent<HonuaEditChangeDetail>;
  }
}
