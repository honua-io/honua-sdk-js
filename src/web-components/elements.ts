import type { HonuaClient } from "../core/client.js";
import type { MapPackageLocator } from "../runtime/index.js";
import { createHonuaWebComponentController } from "./controller.js";
import { redactHonuaExportText } from "./export-redaction.js";
import {
  HONUA_EXPORT_KINDS,
  type HonuaExportAdapter,
  type HonuaExportKind,
  type HonuaExportResult,
  type HonuaExportStatus,
  approximateHonuaScaleLabel,
  createBrowserPrintExportAdapter,
  runHonuaExport,
} from "./export.js";
import {
  type HonuaFeatureEditChangeDetail,
  type HonuaFeatureEditCommitDetail,
  HonuaFeatureEditorElement,
} from "./feature-editor.js";
import type {
  HonuaFeatureTable,
  HonuaFeatureTableConflict,
  HonuaFeatureTableFocusMove,
  HonuaFeatureTableSnapshot,
} from "./feature-table-engine.js";
import {
  featureTableFocusMoveForKey,
  featureTableGridHtml,
  featureTableGridStyles,
  featureTableViewModel,
  legacyFeatureTableViewModel,
} from "./feature-table-view.js";
import { HonuaMapLibreRenderer } from "./maplibre-renderer.js";
import { HonuaMeasurementElement } from "./measurement.js";
import type {
  CreateHonuaWebComponentControllerOptions,
  HonuaActionDetail,
  HonuaActionPanelAction,
  HonuaBasemapChangeDetail,
  HonuaBookmark,
  HonuaBookmarkChangeDetail,
  HonuaChartModel,
  HonuaComponentStatus,
  HonuaControllerReadyDetail,
  HonuaEditChangeDetail,
  HonuaEditorMessages,
  HonuaEditorModel,
  HonuaExportDetail,
  HonuaFeatureRecord,
  HonuaFeatureTableModel,
  HonuaFilterChangeDetail,
  HonuaFullscreenChangeDetail,
  HonuaGeocodeSelectDetail,
  HonuaLayerModel,
  HonuaLayerOpacityChangeDetail,
  HonuaLayerOrderChangeDetail,
  HonuaLayerVisibilityChangeDetail,
  HonuaLegendItem,
  HonuaLocateChangeDetail,
  HonuaLocateControlMessages,
  HonuaMapClickDetail,
  HonuaMapErrorDetail,
  HonuaMapHoverDetail,
  HonuaMapReadyDetail,
  HonuaMeasureChangeDetail,
  HonuaMeasureMode,
  HonuaSearchDetail,
  HonuaSearchGeocodeSuggestion,
  HonuaSearchGeocoderLike,
  HonuaSearchResult,
  HonuaSelectionChangeDetail,
  HonuaSketchChangeDetail,
  HonuaSketchMode,
  HonuaViewportChangeDetail,
  HonuaViewportState,
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
    const focus = captureFocus(root);
    root.innerHTML = html;
    restoreFocus(root, focus);
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
    return ["map-package", "package-url", "src", "label"];
  }

  #options: CreateHonuaWebComponentControllerOptions<T> = {};
  #client: HonuaClient | undefined;
  #packageUrl: string | undefined;
  #renderer: HonuaMapLibreRenderer<T> | undefined;
  #packageLoadToken = 0;
  #packageLoading = false;
  #packageLoadError: string | undefined;

  public get map(): unknown | undefined {
    return this.#renderer?.map;
  }

  public get runtime(): unknown | undefined {
    return this.#renderer?.runtime;
  }

  public get client(): HonuaClient | undefined {
    return this.#client;
  }

  public set client(client: HonuaClient | undefined) {
    this.#client = client;
    void this.syncRenderer();
  }

  public get packageUrl(): string | undefined {
    return this.#packageUrl;
  }

  public set packageUrl(value: string | undefined) {
    this.#packageUrl = value?.trim() || undefined;
    this.#packageLoadError = undefined;
    this.#packageLoading = Boolean(this.#packageUrl);
    this.render();
    if (this.#packageUrl) void this.loadPackageFromUrl(this.#packageUrl);
  }

  public get mapPackage(): CreateHonuaWebComponentControllerOptions<T>["mapPackage"] {
    return this.#options.mapPackage;
  }

  public set mapPackage(mapPackage: CreateHonuaWebComponentControllerOptions<T>["mapPackage"]) {
    this.#options = { ...this.#options, ...(mapPackage ? { mapPackage } : { mapPackage: undefined }) };
    if (mapPackage) {
      this.#packageLoading = false;
      this.#packageLoadError = undefined;
    }
    if (mapPackage) {
      this.controller = createHonuaWebComponentController(this.#options);
    } else if (!this.controller) {
      this.ensureController();
    }
    void this.syncRenderer();
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
        this.#packageLoading = false;
        this.#packageLoadError = "Invalid map-package JSON.";
        this.dispatchTypedEvent<HonuaMapErrorDetail>("honua-map-error", {
          error: new Error("Invalid map-package JSON."),
          message: "Invalid map-package JSON.",
        });
      }
    }
    if ((name === "package-url" || name === "src") && newValue !== null) {
      this.packageUrl = newValue;
    }
    this.render();
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this.ensureController();
    if (this.#packageUrl && !this.state?.mapPackage) void this.loadPackageFromUrl(this.#packageUrl);
    void this.syncRenderer();
  }

  public disconnectedCallback(): void {
    this.#packageLoadToken += 1;
    this.#renderer?.disconnect();
    this.#renderer = undefined;
    super.disconnectedCallback();
  }

  protected controllerChanged(controller: HonuaWebComponentController<T> | undefined): void {
    if (controller) {
      this.dispatchTypedEvent<HonuaControllerReadyDetail<T>>("honua-controller-ready", { controller });
    }
    void this.syncRenderer();
  }

  protected stateChanged(state: HonuaWebComponentState<T>): void {
    void this.#renderer?.applyState(state);
  }

  protected render(): void {
    const state = this.state ?? this.controller?.getState();
    const layers = state?.layers ?? [];
    const viewport = state?.viewport ?? {};
    const visibleLayers = layers.filter((layer) => layer.visible);
    const label = this.getAttribute("label") ?? state?.mapPackage?.mapPackageId ?? "Honua map";
    const root = this.shadowRoot ?? this;
    if (!root.querySelector?.(".map")) {
      this.setShadowHtml(`
        <style>${baseStyles()}${mapStyles()}</style>
        <section part="map" class="map" role="region" aria-label="${escapeHtml(label)}" tabindex="0">
          <div class="map__chrome">
            <div class="map__title"></div>
            <div class="map__controls" aria-label="Map controls">
              <button type="button" class="icon-button" data-zoom="out" aria-label="Zoom out">-</button>
              <output class="zoom" aria-label="Zoom">0</output>
              <button type="button" class="icon-button" data-zoom="in" aria-label="Zoom in">+</button>
            </div>
          </div>
          <div class="map__canvas" part="canvas">
            <div class="map__renderer" part="renderer"></div>
            <div class="map__status" aria-live="polite"></div>
          </div>
          <div class="map__footer">
            <span data-visible-layers>0 visible</span>
            <span data-center>No center</span>
          </div>
        </section>
      `);
      this.bindMapChrome();
    }

    const nextRoot = this.shadowRoot ?? this;
    nextRoot.querySelector(".map")?.setAttribute("aria-label", label);
    setText(nextRoot.querySelector(".map__title"), label);
    setText(nextRoot.querySelector(".zoom"), String(viewport.zoom?.toFixed?.(1) ?? viewport.zoom ?? 0));
    setText(nextRoot.querySelector("[data-visible-layers]"), `${String(visibleLayers.length)} visible`);
    setText(nextRoot.querySelector("[data-center]"), viewport.center ? viewport.center.join(", ") : "No center");
    setText(nextRoot.querySelector(".map__status"), this.mapStatusText(state));
    void this.syncRenderer();
  }

  private ensureController(): void {
    if (this.controller) return;
    this.controller = createHonuaWebComponentController(this.#options);
  }

  private bindMapChrome(): void {
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((button) => {
      button.addEventListener("click", () => {
        const direction = button.dataset.zoom === "in" ? 1 : -1;
        const nextZoom = (this.controller?.getState().viewport.zoom ?? 0) + direction;
        this.controller?.setViewport({ zoom: nextZoom });
        this.dispatchTypedEvent<HonuaViewportChangeDetail>("honua-viewport-change", { zoom: nextZoom });
      });
    });
  }

  private async syncRenderer(): Promise<void> {
    if (!this.isConnected || !this.controller) return;
    const container = this.shadowRoot?.querySelector<HTMLElement>(".map__renderer");
    if (!container) return;
    if (!this.#renderer) {
      this.#renderer = new HonuaMapLibreRenderer<T>({
        container,
        getClient: () => this.#client,
        getController: () => this.controller,
        onReady: (detail) => {
          this.dispatchTypedEvent<HonuaMapReadyDetail<T>>("honua-map-ready", detail);
          this.render();
        },
        onError: (detail) => {
          this.dispatchTypedEvent<HonuaMapErrorDetail>("honua-map-error", detail);
          setText(this.shadowRoot?.querySelector(".map__status"), detail.message);
        },
        onViewport: (detail) => {
          this.dispatchTypedEvent<HonuaViewportChangeDetail>("honua-viewport-change", detail);
          this.render();
        },
        onClick: (detail) => this.dispatchTypedEvent<HonuaMapClickDetail<T>>("honua-map-click", detail),
        onHover: (detail) => this.dispatchTypedEvent<HonuaMapHoverDetail<T>>("honua-map-hover", detail),
        onSelection: (detail) =>
          this.dispatchTypedEvent<HonuaSelectionChangeDetail<T>>("honua-selection-change", detail),
      });
    }
    const state = this.controller.getState();
    this.state = state;
    await this.#renderer.applyState(state);
  }

  private async loadPackageFromUrl(locator: MapPackageLocator): Promise<void> {
    const token = ++this.#packageLoadToken;
    this.#packageLoading = true;
    this.#packageLoadError = undefined;
    this.render();
    try {
      const [{ fetchMapPackage }, { HonuaClient }] = await Promise.all([
        import("../runtime/index.js"),
        import("../core/client.js"),
      ]);
      if (token !== this.#packageLoadToken) return;
      const client = this.#client ?? new HonuaClient({ baseUrl: browserOrigin() });
      const result = await fetchMapPackage(locator, {
        client,
        requireStyleRefResolution: false,
        allowInvalid: false,
      });
      if (token !== this.#packageLoadToken) return;
      this.mapPackage = result.mapPackage;
      this.#packageLoading = false;
      this.#packageLoadError = undefined;
      await this.syncRenderer();
      this.render();
    } catch (error) {
      if (token !== this.#packageLoadToken) return;
      this.#packageLoading = false;
      this.#packageLoadError = error instanceof Error ? error.message : String(error);
      this.dispatchTypedEvent<HonuaMapErrorDetail>("honua-map-error", {
        error,
        message: this.#packageLoadError,
      });
      this.render();
    }
  }

  private mapStatusText(state: HonuaWebComponentState<T> | undefined): string {
    if (this.#packageLoadError) return this.#packageLoadError;
    if (state?.mapPackage) return "";
    if (this.#packageLoading || this.#packageUrl) return "Loading map package";
    return "No map package";
  }
}

/**
 * `<honua-layer-list>` — the survival-tier layer list (issue #493). Renders a
 * row per runtime layer (in style order: the last row draws on top) with:
 *
 * - a visibility checkbox bound to `controller.setLayerVisibility`;
 * - an opacity slider (rendered when the controller implements
 *   `setLayerOpacity`), committed on `change` so keyboard arrows and pointer
 *   drags both work;
 * - reorder affordances (rendered when the controller implements
 *   `moveLayer`): keyboard-operable "Move up"/"Move down" buttons plus HTML5
 *   drag-and-drop between rows.
 *
 * Rows re-render from controller state events, so external visibility /
 * opacity / order changes stay in sync. Theme via the `--honua-ui-*` CSS
 * custom properties; rows are exposed as a `role="list"` of `listitem`s.
 */
export class HonuaLayerListElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #dragLayerId: string | undefined;
  #layersOverride: readonly HonuaLayerModel[] | undefined;

  /**
   * The layer rows currently rendered. Headless hosts (for example the
   * esri-compat LayerList shim delegating through `HonuaWidgetHost`) can
   * assign this directly to bypass the controller; user toggles then surface
   * only through the `honua-layer-visibility-change` event. Assign
   * `undefined` to return to controller-driven rows.
   */
  public get layers(): readonly HonuaLayerModel[] {
    return this.#layersOverride ?? this.state?.layers ?? [];
  }

  public set layers(layers: readonly HonuaLayerModel[] | undefined) {
    this.#layersOverride = layers;
    this.render();
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected controllerChanged(): void {
    this.render();
  }

  protected render(): void {
    const layers = this.layers;
    const label = this.getAttribute("label") ?? "Layers";
    const supportsOpacity = typeof this.controller?.setLayerOpacity === "function";
    const supportsReorder = typeof this.controller?.moveLayer === "function";
    this.setShadowHtml(`
      <style>${baseStyles()}${listStyles()}${layerListStyles()}</style>
      <fieldset class="panel" part="panel">
        <legend>${escapeHtml(label)}</legend>
        <div class="stack" role="list">
          ${
            layers.length === 0
              ? `<p class="empty">No layers</p>`
              : layers
                  .map((layer, index) => this.renderRow(layer, index, layers.length, supportsOpacity, supportsReorder))
                  .join("")
          }
        </div>
      </fieldset>
    `);
    this.bindRows(supportsReorder);
  }

  private renderRow(
    layer: HonuaLayerModel,
    index: number,
    count: number,
    supportsOpacity: boolean,
    supportsReorder: boolean,
  ): string {
    const id = escapeAttribute(layer.id);
    const opacityPercent = Math.round((layer.opacity ?? 1) * 100);
    // Generic control names ("Opacity", "Move up") keep each row's checkbox as
    // the only control whose accessible name is the layer title; the
    // surrounding listitem carries the title for context.
    const opacity = supportsOpacity
      ? `
        <input
          type="range"
          class="opacity"
          part="opacity"
          min="0"
          max="100"
          step="1"
          value="${opacityPercent}"
          aria-label="Opacity"
          aria-valuetext="${opacityPercent}%"
          data-layer-opacity="${id}"
        />`
      : "";
    const reorder = supportsReorder
      ? `
        <button type="button" class="move" part="move-up" aria-label="Move up" data-move="up:${id}" ${
          index === 0 ? "disabled" : ""
        }>&#9650;</button>
        <button type="button" class="move" part="move-down" aria-label="Move down" data-move="down:${id}" ${
          index === count - 1 ? "disabled" : ""
        }>&#9660;</button>`
      : "";
    return `
      <div class="layer-row" role="listitem" part="row" data-layer-row="${id}"${
        supportsReorder ? ` draggable="true"` : ""
      }>
        <label class="check-row">
          <input type="checkbox" data-layer-id="${id}" ${layer.visible ? "checked" : ""} />
          <span>${escapeHtml(layer.title)}</span>
        </label>
        ${supportsOpacity || supportsReorder ? `<div class="layer-row__tools">${opacity}${reorder}</div>` : ""}
      </div>
    `;
  }

  private bindRows(supportsReorder: boolean): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLInputElement>("input[data-layer-id]").forEach((input) => {
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
    root.querySelectorAll<HTMLInputElement>("input[data-layer-opacity]").forEach((input) => {
      input.addEventListener("change", () => {
        const layerId = input.dataset.layerOpacity;
        if (!layerId) return;
        const opacity = Math.min(1, Math.max(0, Number(input.value) / 100));
        this.controller?.setLayerOpacity?.(layerId, opacity);
        this.dispatchTypedEvent<HonuaLayerOpacityChangeDetail>("honua-layer-opacity-change", { layerId, opacity });
      });
    });
    root.querySelectorAll<HTMLButtonElement>("button[data-move]").forEach((button) => {
      button.addEventListener("click", () => {
        const encoded = button.dataset.move ?? "";
        const separator = encoded.indexOf(":");
        if (separator === -1) return;
        const direction = encoded.slice(0, separator);
        const layerId = encoded.slice(separator + 1);
        this.moveByOffset(layerId, direction === "up" ? -1 : 1);
      });
    });
    if (!supportsReorder) return;
    root.querySelectorAll<HTMLElement>("[data-layer-row]").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        const layerId = row.dataset.layerRow;
        if (!layerId) return;
        this.#dragLayerId = layerId;
        const transfer = (event as DragEvent).dataTransfer;
        transfer?.setData("text/plain", layerId);
        if (transfer) transfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (event) => {
        if (this.#dragLayerId) event.preventDefault();
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const source = this.#dragLayerId ?? (event as DragEvent).dataTransfer?.getData("text/plain");
        const target = row.dataset.layerRow;
        this.#dragLayerId = undefined;
        if (!source || !target || source === target) return;
        this.moveBefore(source, target);
      });
      row.addEventListener("dragend", () => {
        this.#dragLayerId = undefined;
      });
    });
  }

  /** Moves a layer one list position up (`-1`) or down (`+1`). */
  private moveByOffset(layerId: string, offset: -1 | 1): void {
    const layers = this.layers;
    const index = layers.findIndex((layer) => layer.id === layerId);
    if (index === -1) return;
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= layers.length) return;
    const beforeId = offset === -1 ? layers[index - 1]?.id : layers[index + 2]?.id;
    this.applyMove(layerId, beforeId);
  }

  private moveBefore(layerId: string, targetId: string): void {
    this.applyMove(layerId, targetId);
  }

  private applyMove(layerId: string, beforeId: string | undefined): void {
    const controller = this.controller;
    if (!controller?.moveLayer) return;
    controller.moveLayer(layerId, beforeId);
    this.dispatchTypedEvent<HonuaLayerOrderChangeDetail>("honua-layer-order-change", {
      layerId,
      ...(beforeId !== undefined ? { beforeId } : {}),
      order: controller.getState().layers.map((layer) => layer.id),
    });
  }
}

/**
 * `<honua-legend>` — the survival-tier legend (issue #493). Renders
 * swatch+label rows from the controller's runtime legend model
 * (`HonuaLegendItem[]` derived from the map package / renderer metadata) and
 * reacts to layer visibility changes: entries carrying a `layerId` are hidden
 * while that layer is toggled off, unless the `include-hidden` attribute is
 * present.
 *
 * Headless hosts (for example the esri-compat Legend shim delegating through
 * `HonuaWidgetHost`) can bypass the controller and assign the `items`
 * property directly.
 *
 * Swatches are `aria-hidden` presentation; the text labels carry the meaning.
 * Theme via the `--honua-ui-*` CSS custom properties.
 */
export class HonuaLegendElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label", "include-hidden"];
  }

  #itemsOverride: readonly HonuaLegendItem[] | undefined;

  /**
   * Explicit legend items. When set, these render instead of the controller
   * state's legend (visibility coupling still applies when the controller is
   * also present). Assign `undefined` to return to controller-driven items.
   */
  public get items(): readonly HonuaLegendItem[] | undefined {
    return this.#itemsOverride;
  }

  public set items(items: readonly HonuaLegendItem[] | undefined) {
    this.#itemsOverride = items;
    this.render();
  }

  /** Render entries for hidden layers too. Reflects the `include-hidden` attribute. */
  public get includeHidden(): boolean {
    return typeof this.hasAttribute === "function" && this.hasAttribute("include-hidden");
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  /** The items currently rendered (after layer-visibility filtering). */
  public get visibleItems(): readonly HonuaLegendItem[] {
    const items = this.#itemsOverride ?? this.state?.legend ?? [];
    if (this.includeHidden) return items;
    const layers = this.state?.layers ?? [];
    return items.filter((item) => {
      if (!item.layerId) return true;
      const layer = layers.find((candidate) => candidate.id === item.layerId);
      return layer ? layer.visible : true;
    });
  }

  protected render(): void {
    const legend = this.visibleItems;
    const label = this.getAttribute("label") ?? "Legend";
    this.setShadowHtml(`
      <style>${baseStyles()}${listStyles()}${legendStyles()}</style>
      <section class="panel" part="panel" aria-label="${escapeHtml(label)}">
        <h2>${escapeHtml(label)}</h2>
        <ul class="legend" role="list">
          ${
            legend.length === 0
              ? `<li class="empty">No legend</li>`
              : legend
                  .map(
                    (item) => `
            <li role="listitem" data-legend-item="${escapeAttribute(item.id)}">
              ${
                item.iconUrl
                  ? `<img class="swatch" alt="" aria-hidden="true" src="${escapeAttribute(item.iconUrl)}" />`
                  : `<span class="swatch" aria-hidden="true" style="--swatch:${escapeAttribute(item.color ?? "#64748b")}"></span>`
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

/**
 * `<honua-feature-table>` — the production feature grid (issue #681).
 *
 * Two lanes, both rendering the same accessible WAI-ARIA `grid`:
 *
 * - **Bounded lane** (recommended for operational apps) — assign the `table`
 *   property a {@link HonuaFeatureTable} from
 *   {@link createHonuaFeatureTable}. The element then renders the engine's
 *   virtualized window, drives remote paging from real scroll geometry, pushes
 *   header clicks into multi-column sort, exposes total-known / estimated /
 *   partial / stale / loading / cancelled / unsupported / error truth, and
 *   announces realtime reconciliation conflicts in a polite live region.
 * - **Controller lane** (unchanged, backwards compatible) — with no engine
 *   attached the element queries the shared controller for a single bounded
 *   page, exactly as before, and renders it through the same grid markup so the
 *   keyboard and screen-reader contract does not depend on which lane is in use.
 *
 * Keyboard: arrow keys move the focused cell, `Home`/`End` jump within the row
 * (`Ctrl`/`Cmd` to the grid), `PageUp`/`PageDown` move a window at a time —
 * loading the page the focus lands on in the bounded lane — and
 * `Enter`/`Space` selects the focused row. Exactly one cell is tabbable
 * (roving `tabindex`).
 */
export class HonuaFeatureTableElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "source", "fields", "page-size", "filter-text", "label", "row-height"];
  }

  #model: HonuaFeatureTableModel<T> | undefined;
  #refreshToken = 0;
  #table: HonuaFeatureTable<T> | undefined;
  #tableUnsubscribe: (() => void) | undefined;
  #tableSnapshot: HonuaFeatureTableSnapshot<T> | undefined;
  #announcedConflicts = "";
  #tableConnected = false;
  #restoringScroll = false;

  /**
   * The bounded query engine backing this grid. Assigning one switches the
   * element to the bounded lane; assigning `undefined` restores the
   * controller-driven single-page lane.
   */
  public get table(): HonuaFeatureTable<T> | undefined {
    return this.#table;
  }

  public set table(table: HonuaFeatureTable<T> | undefined) {
    if (this.#table === table) {
      // Re-assigning the same engine must still be able to re-take a
      // subscription that `disconnectedCallback()` dropped.
      this.#subscribeTable();
      return;
    }
    this.#tableUnsubscribe?.();
    this.#tableUnsubscribe = undefined;
    this.#table = table;
    this.#tableSnapshot = table?.snapshot;
    // Only hold a subscription while connected; `connectedCallback()` re-takes
    // it so a detached-then-reinserted grid resumes updating.
    this.#subscribeTable();
    this.render();
  }

  /** Takes the engine subscription, unless one is already held or we are detached. */
  #subscribeTable(): void {
    const table = this.#table;
    if (!table || this.#tableUnsubscribe || !this.#tableConnected) return;
    // The engine may have moved on while detached; re-read before listening.
    this.#tableSnapshot = table.snapshot;
    this.#tableUnsubscribe = table.subscribe((snapshot) => {
      this.#tableSnapshot = snapshot;
      this.render();
      this.#announceConflicts(snapshot);
    });
  }

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
    this.#tableConnected = true;
    super.connectedCallback();
    this.#subscribeTable();
    if (this.#table) {
      // Reconnect must not re-query: the engine already holds bounded pages, and
      // re-taking the subscription plus a render is enough to resume.
      this.render();
      return;
    }
    void this.refresh();
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#tableConnected = false;
    this.#tableUnsubscribe?.();
    this.#tableUnsubscribe = undefined;
  }

  protected stateChanged(): void {
    if (this.#table) {
      // Selection is owned by the engine (and, through it, shared exploration
      // state) in the bounded lane — a controller state change must not trigger
      // an unbounded re-query.
      this.render();
      return;
    }
    void this.refresh();
  }

  public async refresh(): Promise<HonuaFeatureTableModel<T> | undefined> {
    if (this.#table) {
      const snapshot = await this.#table.refresh();
      this.#tableSnapshot = snapshot;
      this.render();
      return featureTableModelFromSnapshot(snapshot);
    }
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
    const label = this.getAttribute("label") ?? "Features";
    const rowHeight = this.rowHeight();
    const snapshot = this.#tableSnapshot;
    const viewModel = snapshot
      ? featureTableViewModel(snapshot, { label, rowHeight })
      : legacyFeatureTableViewModel(
          this.#model ?? tableModelFromState(this.state, this.sourceId(), this.fields(), this.pageSize()),
          {
            label,
            rowHeight,
            ...(this.state?.selection?.featureId !== undefined
              ? { selectedFeatureId: String(this.state.selection.featureId) }
              : {}),
          },
        );

    // `setShadowHtml` replaces the whole shadow tree, including the scroll
    // container. A fresh container starts at `scrollTop = 0`, which would snap a
    // virtualized grid back to the top (and strand a full-height leading spacer)
    // on every publish — including the synchronous loading snapshot that
    // `setScroll` itself publishes. Carry the offset across the swap.
    const previousScrollTop = this.#scroller()?.scrollTop ?? 0;
    this.setShadowHtml(
      `<style>${baseStyles()}${tableStyles()}${featureTableGridStyles()}</style>${featureTableGridHtml(viewModel)}`,
    );
    this.#bindGrid();
    this.#restoreScrollTop(previousScrollTop);
  }

  #scroller(): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>("[data-scroller]") ?? null;
  }

  #restoreScrollTop(scrollTop: number): void {
    if (scrollTop <= 0) return;
    const scroller = this.#scroller();
    if (!scroller || scroller.scrollTop === scrollTop) return;
    // Restoring the offset fires `scroll`; that echo must not be mistaken for a
    // user gesture and fed back into the engine as a new window.
    this.#restoringScroll = true;
    scroller.scrollTop = scrollTop;
    queueMicrotask(() => {
      this.#restoringScroll = false;
    });
  }

  #bindGrid(): void {
    const root = this.shadowRoot;
    if (!root) return;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-sort-field]")) {
      button.addEventListener("click", (event) => {
        const field = button.dataset.sortField;
        if (!field) return;
        void this.#table?.toggleSort(field, { additive: (event as MouseEvent).shiftKey });
      });
    }
    for (const row of root.querySelectorAll<HTMLTableRowElement>("tbody tr[data-feature-id]")) {
      row.addEventListener("click", () => this.selectRow(row));
      row.addEventListener("keydown", (event) => this.#onRowKeydown(event as KeyboardEvent, row));
    }
    for (const cell of root.querySelectorAll<HTMLTableCellElement>('tbody [role="gridcell"]')) {
      cell.addEventListener("focus", () => this.#focusCell(cell));
      cell.addEventListener("keydown", (event) => this.#onGridKeydown(event as KeyboardEvent, cell));
    }
    const scroller = root.querySelector<HTMLElement>("[data-scroller]");
    if (scroller && this.#table) {
      scroller.addEventListener("scroll", () => {
        if (this.#restoringScroll) return;
        void this.#table?.setScroll({
          scrollTop: scroller.scrollTop,
          rowHeight: this.rowHeight(),
          viewportHeight: scroller.clientHeight || this.rowHeight() * 10,
        });
      });
    }
  }

  /**
   * Keys pressed while the **row** itself holds focus, rather than one of its
   * cells. Cells handle their own keys and their events bubble through the row,
   * so this bails unless the row is the actual target — no double handling.
   *
   * Enter/Space selects, matching the row-level activation the grid has always
   * offered. Any navigation key hands focus to the row's first cell, which is
   * where the roving-tabindex model takes over.
   */
  #onRowKeydown(event: KeyboardEvent, row: HTMLTableRowElement): void {
    if (event.target !== row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.selectRow(row);
      return;
    }
    if (!featureTableFocusMoveForKey(event.key, { ctrl: event.ctrlKey, meta: event.metaKey })) return;
    const cell = row.querySelector<HTMLTableCellElement>('[role="gridcell"]');
    if (!cell) return;
    event.preventDefault();
    cell.focus();
  }

  #focusCell(cell: HTMLTableCellElement): void {
    const rowKey = cell.closest<HTMLTableRowElement>("tr")?.dataset.rowKey;
    const field = cell.dataset.field;
    if (!rowKey || !field || !this.#table) return;
    if (this.#tableSnapshot?.focus?.rowKey === rowKey && this.#tableSnapshot.focus.field === field) return;
    this.#table.setFocus({ rowKey, field });
  }

  #onGridKeydown(event: KeyboardEvent, cell: HTMLTableCellElement): void {
    const row = cell.closest<HTMLTableRowElement>("tr");
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row) this.selectRow(row);
      return;
    }
    const move = featureTableFocusMoveForKey(event.key, { ctrl: event.ctrlKey, meta: event.metaKey });
    if (!move) return;
    event.preventDefault();
    const table = this.#table;
    if (!table) {
      this.#moveDomFocus(move, cell, row);
      return;
    }
    if (!this.#tableSnapshot?.focus) this.#focusCell(cell);
    void table.moveFocus(move).then(() => this.#restoreFocusedCell());
  }

  /** Controller lane: move focus within the rendered rows only — no paging. */
  #moveDomFocus(move: HonuaFeatureTableFocusMove, cell: HTMLTableCellElement, row: HTMLTableRowElement | null): void {
    const root = this.shadowRoot;
    if (!root || !row) return;
    const rows = [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    const cells = [...row.querySelectorAll<HTMLTableCellElement>('[role="gridcell"]')];
    const rowIndex = rows.indexOf(row);
    const cellIndex = cells.indexOf(cell);
    const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
    let nextRow = rowIndex;
    let nextCell = cellIndex;
    if (move === "up") nextRow -= 1;
    else if (move === "down") nextRow += 1;
    else if (move === "left") nextCell -= 1;
    else if (move === "right") nextCell += 1;
    else if (move === "row-start") nextCell = 0;
    else if (move === "row-end") nextCell = cells.length - 1;
    else if (move === "page-up") nextRow = 0;
    else if (move === "page-down") nextRow = rows.length - 1;
    else if (move === "grid-start") {
      nextRow = 0;
      nextCell = 0;
    } else if (move === "grid-end") {
      nextRow = rows.length - 1;
      nextCell = cells.length - 1;
    }
    const target =
      rows[clamp(nextRow, rows.length - 1)]?.querySelectorAll<HTMLTableCellElement>('[role="gridcell"]')[
        clamp(nextCell, cells.length - 1)
      ];
    target?.focus();
  }

  #restoreFocusedCell(): void {
    const focus = this.#tableSnapshot?.focus;
    const root = this.shadowRoot;
    if (!focus || !root) return;
    const selector = `tbody tr[data-row-key="${cssEscape(focus.rowKey)}"] [data-field="${cssEscape(focus.field)}"]`;
    root.querySelector<HTMLTableCellElement>(selector)?.focus();
  }

  #announceConflicts(snapshot: HonuaFeatureTableSnapshot<T>): void {
    const digest = snapshot.conflicts.map((conflict) => `${conflict.code}:${conflict.rowKeys.join(",")}`).join("|");
    if (digest === this.#announcedConflicts) return;
    this.#announcedConflicts = digest;
    for (const conflict of snapshot.conflicts) {
      this.dispatchTypedEvent<HonuaFeatureTableConflictDetail>("honua-table-conflict", {
        code: conflict.code,
        message: conflict.message,
        rowKeys: conflict.rowKeys,
      });
    }
  }

  private selectRow(row: HTMLTableRowElement): void {
    const sourceId = row.dataset.sourceId;
    const featureId = row.dataset.featureId;
    if (!sourceId || featureId === undefined) return;
    const rowKey = row.dataset.rowKey;
    if (this.#table && rowKey) this.#table.select([rowKey]);
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

  private rowHeight(): number {
    const parsed = Number(this.getAttribute("row-height"));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
  }
}

/** Detail of the `honua-table-conflict` event dispatched by `<honua-feature-table>`. */
export interface HonuaFeatureTableConflictDetail {
  readonly code: HonuaFeatureTableConflict["code"];
  readonly message: string;
  readonly rowKeys: readonly string[];
}

/**
 * Project a bounded snapshot onto the legacy {@link HonuaFeatureTableModel} so
 * existing `refresh()` callers keep compiling. `totalCount` is only the
 * engine's count when the engine actually knows one; a partial or unknown count
 * reports the resident row count, which the `exceededTransferLimit` flag marks
 * as incomplete rather than presenting it as a total.
 */
function featureTableModelFromSnapshot<T>(snapshot: HonuaFeatureTableSnapshot<T>): HonuaFeatureTableModel<T> {
  const rows = snapshot.rows.filter((row): row is NonNullable<typeof row> => row !== undefined);
  const known = snapshot.count.kind === "known" || snapshot.count.kind === "estimated";
  return {
    sourceId: snapshot.sourceId,
    status: legacyStatusForState(snapshot.state),
    fields: snapshot.visibleColumns.map((column) => column.field),
    rows: rows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      attributes: row.attributes,
      ...(row.geometry !== undefined ? { geometry: row.geometry } : {}),
    })),
    totalCount: known ? (snapshot.count.value ?? snapshot.count.loaded) : snapshot.count.loaded,
    ...(known ? {} : { exceededTransferLimit: true }),
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
  };
}

function legacyStatusForState(state: HonuaFeatureTableSnapshot["state"]): HonuaComponentStatus {
  switch (state) {
    case "idle":
      return "idle";
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "unsupported":
      return "unsupported";
    default:
      return "ready";
  }
}

/** Minimal `CSS.escape` for the attribute selectors this element builds. */
function cssEscape(value: string): string {
  return value.split("\\").join("\\\\").split('"').join('\\"');
}

/**
 * `<honua-search>` — the survival-tier search box (issue #493).
 *
 * Two lanes:
 *
 * - **Feature search** (default) — submitting the form runs
 *   `controller.search` over the shared dataset state and renders selectable
 *   feature results (the pre-existing behavior).
 * - **Geocoding search** — assign the `geocoder` property a provider
 *   satisfying {@link HonuaSearchGeocoderLike} (a `HonuaGeocodingClient` from
 *   the stable `@honua/sdk-js/geocoding` entrypoint fits structurally). The
 *   input becomes an ARIA combobox with debounced typeahead suggestions
 *   (`debounce` attribute, default 250 ms) navigated with ArrowUp / ArrowDown,
 *   accepted with Enter, dismissed with Escape. Selecting a suggestion (or
 *   submitting) forward-geocodes and pans/zooms the map by writing the
 *   controller viewport (`zoom` attribute, default 15), then dispatches
 *   `honua-geocode-select`.
 */
export class HonuaSearchElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "source", "placeholder", "label", "submit-label", "debounce", "zoom"];
  }

  #query = "";
  #results: readonly HonuaSearchResult<T>[] = [];
  #geocoder: HonuaSearchGeocoderLike | undefined;
  #suggestions: readonly HonuaSearchGeocodeSuggestion[] = [];
  #activeIndex = -1;
  #status = "";
  #suggestTimer: ReturnType<typeof setTimeout> | undefined;
  #suggestToken = 0;
  #geocodeToken = 0;

  /** The geocoding provider powering typeahead + geocode-on-submit. */
  public get geocoder(): HonuaSearchGeocoderLike | undefined {
    return this.#geocoder;
  }

  public set geocoder(geocoder: HonuaSearchGeocoderLike | undefined) {
    this.#geocoder = geocoder;
    this.#clearSuggestTimer();
    this.#suggestions = [];
    this.#activeIndex = -1;
    this.#status = "";
    this.render();
  }

  /**
   * Text rendered in the form's submit button. Defaults to `"Search"` for
   * compatibility with the original markup. The property reflects the
   * `submit-label` attribute so either caller API can supply localized text.
   */
  public get submitLabel(): string {
    return this.getAttribute("submit-label") ?? "Search";
  }

  public set submitLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("submit-label");
    else this.setAttribute("submit-label", value);
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#clearSuggestTimer();
    super.disconnectedCallback();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Search";
    const placeholder = this.getAttribute("placeholder") ?? "Search";
    const submitLabel = this.submitLabel;
    const geocoding = this.#geocoder !== undefined;
    const expanded = geocoding && this.#suggestions.length > 0;
    const comboboxAttributes = geocoding
      ? ` role="combobox" aria-autocomplete="list" aria-expanded="${String(expanded)}" aria-controls="honua-search-listbox"${
          this.#activeIndex >= 0 ? ` aria-activedescendant="honua-search-option-${this.#activeIndex}"` : ""
        }`
      : "";
    this.setShadowHtml(`
      <style>${baseStyles()}${searchStyles()}</style>
      <section class="search" part="panel" aria-label="${escapeHtml(label)}">
        <form>
          <label class="sr-only" for="honua-search-input">${escapeHtml(label)}</label>
          <input id="honua-search-input" name="q" value="${escapeAttribute(this.#query)}" placeholder="${escapeAttribute(
            placeholder,
          )}" autocomplete="off"${comboboxAttributes} />
          <button type="submit">${escapeHtml(submitLabel)}</button>
        </form>
        ${
          geocoding
            ? `<ul class="suggestions" id="honua-search-listbox" role="listbox" aria-label="${escapeAttribute(
                `${label} suggestions`,
              )}"${expanded ? "" : " hidden"}>
          ${this.#suggestions
            .map(
              (suggestion, index) =>
                `<li id="honua-search-option-${index}" role="option" aria-selected="${String(
                  index === this.#activeIndex,
                )}" data-suggestion-index="${index}">${escapeHtml(suggestion.text)}</li>`,
            )
            .join("")}
        </ul>
        <p class="status" role="status" aria-live="polite">${escapeHtml(this.#status)}</p>`
            : ""
        }
        <ul class="results" aria-live="polite">
          ${this.#results.map((result) => `<li><button type="button" data-result-id="${escapeHtml(result.id)}">${escapeHtml(result.label)}</button></li>`).join("")}
        </ul>
      </section>
    `);
    const input = this.shadowRoot?.querySelector<HTMLInputElement>("input[name='q']");
    this.shadowRoot?.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input?.value ?? "";
      if (this.#geocoder) void this.runGeocode(query);
      else void this.runSearch(query);
    });
    // The typed query is tracked unconditionally, not only when a geocoder is
    // assigned. `render()` re-creates the input from `#query`, so without this
    // any controller-driven re-render (a viewport change, a layer toggle, a
    // realtime refresh) silently wiped whatever the user had typed — the
    // focus-restoration gate this is measured against (issue #683, REQ-004)
    // found exactly that. Suggestion scheduling stays geocoder-gated.
    input?.addEventListener("input", () => {
      this.#query = input.value;
      if (this.#geocoder) this.scheduleSuggest();
    });
    if (this.#geocoder) {
      input?.addEventListener("keydown", (event) => this.onComboboxKeydown(event));
      this.shadowRoot?.querySelectorAll<HTMLLIElement>("li[data-suggestion-index]").forEach((option) => {
        option.addEventListener("click", () => {
          const index = Number(option.dataset.suggestionIndex);
          if (Number.isInteger(index)) void this.selectSuggestion(index);
        });
      });
    }
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

  private onComboboxKeydown(event: KeyboardEvent): void {
    if (this.#suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = this.#suggestions.length;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      this.#activeIndex = (this.#activeIndex + offset + count) % count;
      this.render();
      return;
    }
    if (event.key === "Enter" && this.#activeIndex >= 0) {
      event.preventDefault();
      void this.selectSuggestion(this.#activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.#clearSuggestTimer();
      this.#suggestions = [];
      this.#activeIndex = -1;
      this.render();
    }
  }

  private scheduleSuggest(): void {
    this.#clearSuggestTimer();
    const geocoder = this.#geocoder;
    if (!geocoder?.suggest) return;
    const text = this.#query.trim();
    if (!text) {
      this.#suggestions = [];
      this.#activeIndex = -1;
      this.render();
      return;
    }
    this.#suggestTimer = setTimeout(() => {
      this.#suggestTimer = undefined;
      void this.runSuggest(text);
    }, this.debounceMs());
  }

  private async runSuggest(text: string): Promise<void> {
    const geocoder = this.#geocoder;
    if (!geocoder?.suggest) return;
    const token = ++this.#suggestToken;
    try {
      const suggestions = await geocoder.suggest(text, { maxSuggestions: 8 });
      if (token !== this.#suggestToken) return;
      this.#suggestions = suggestions;
      this.#activeIndex = -1;
      this.render();
    } catch (error) {
      if (token !== this.#suggestToken) return;
      this.#suggestions = [];
      this.#activeIndex = -1;
      this.#status = error instanceof Error ? error.message : "Suggestions unavailable.";
      this.render();
    }
  }

  private async selectSuggestion(index: number): Promise<void> {
    const suggestion = this.#suggestions[index];
    if (!suggestion) return;
    this.#query = suggestion.text;
    this.#suggestions = [];
    this.#activeIndex = -1;
    await this.runGeocode(suggestion.text);
  }

  private async runGeocode(query: string): Promise<void> {
    const geocoder = this.#geocoder;
    if (!geocoder) return;
    this.#clearSuggestTimer();
    this.#suggestToken += 1;
    // Overlapping geocodes resolve out of order on slow networks; only the
    // most recent request may write the viewport/status or emit the event.
    const token = ++this.#geocodeToken;
    this.#query = query;
    this.#suggestions = [];
    this.#activeIndex = -1;
    const trimmed = query.trim();
    if (!trimmed) {
      this.#status = "";
      this.render();
      return;
    }
    try {
      const candidates = await geocoder.forwardGeocode(trimmed, { maxResults: 1 });
      if (token !== this.#geocodeToken) return;
      const candidate = candidates[0];
      if (!candidate) {
        this.#status = `No results for "${trimmed}".`;
        this.render();
        return;
      }
      const viewport: HonuaViewportState = {
        center: [candidate.longitude, candidate.latitude],
        zoom: this.resultZoom(),
      };
      this.controller?.setViewport(viewport);
      this.#status = candidate.address;
      this.dispatchTypedEvent<HonuaGeocodeSelectDetail>("honua-geocode-select", {
        query: trimmed,
        candidate,
        viewport,
      });
      this.render();
    } catch (error) {
      if (token !== this.#geocodeToken) return;
      this.#status = error instanceof Error ? error.message : "Geocoding failed.";
      this.render();
    }
  }

  private async runSearch(query: string): Promise<void> {
    this.#query = query;
    const sourceId = this.getAttribute("source") ?? undefined;
    this.#results = await (this.controller?.search(query, { sourceId }) ?? []);
    this.dispatchTypedEvent<HonuaSearchDetail<T>>("honua-search", { query, results: this.#results });
    this.render();
  }

  private debounceMs(): number {
    const parsed = Number(this.getAttribute("debounce"));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
  }

  private resultZoom(): number {
    const parsed = Number(this.getAttribute("zoom"));
    return Number.isFinite(parsed) ? parsed : 15;
  }

  #clearSuggestTimer(): void {
    if (this.#suggestTimer === undefined) return;
    clearTimeout(this.#suggestTimer);
    this.#suggestTimer = undefined;
  }
}

export class HonuaEditorElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return [
      "for",
      "source",
      "label",
      "new-label",
      "save-label",
      "delete-label",
      "no-selection-label",
      "read-only-label",
      "editable-label",
    ];
  }

  #model: HonuaEditorModel | undefined;
  #messages: HonuaEditorMessages = {};

  public get editorModel(): HonuaEditorModel | undefined {
    return this.#model ?? this.state?.editor;
  }

  public set editorModel(model: HonuaEditorModel | undefined) {
    this.#model = model;
    this.render();
  }

  /** Caller-supplied localized status and read-only messages. */
  public get messages(): HonuaEditorMessages {
    return this.#messages;
  }

  public set messages(messages: HonuaEditorMessages | undefined) {
    this.#messages = messages ?? {};
    this.render();
  }

  /** Text rendered by the create action. Defaults to `"New"`. */
  public get newLabel(): string {
    return this.getAttribute("new-label") ?? "New";
  }

  public set newLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("new-label");
    else this.setAttribute("new-label", value);
  }

  /** Text rendered by the save action. Defaults to `"Save"`. */
  public get saveLabel(): string {
    return this.getAttribute("save-label") ?? "Save";
  }

  public set saveLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("save-label");
    else this.setAttribute("save-label", value);
  }

  /** Text rendered by the delete action. Defaults to `"Delete"`. */
  public get deleteLabel(): string {
    return this.getAttribute("delete-label") ?? "Delete";
  }

  public set deleteLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("delete-label");
    else this.setAttribute("delete-label", value);
  }

  /** Text rendered when no feature is selected. Defaults to `"No selection"`. */
  public get noSelectionLabel(): string {
    return this.getAttribute("no-selection-label") ?? "No selection";
  }

  public set noSelectionLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("no-selection-label");
    else this.setAttribute("no-selection-label", value);
  }

  /** Text rendered for a read-only editor without a model-supplied reason. Defaults to `"Read-only"`. */
  public get readOnlyLabel(): string {
    return this.getAttribute("read-only-label") ?? "Read-only";
  }

  public set readOnlyLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("read-only-label");
    else this.setAttribute("read-only-label", value);
  }

  /** Text rendered for an editable editor. Defaults to `"Editable"`. */
  public get editableLabel(): string {
    return this.getAttribute("editable-label") ?? "Editable";
  }

  public set editableLabel(value: string | undefined) {
    if (value === undefined) this.removeAttribute("editable-label");
    else this.setAttribute("editable-label", value);
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
    const newLabel = this.newLabel;
    const saveLabel = this.saveLabel;
    const deleteLabel = this.deleteLabel;
    const noSelectionLabel = this.noSelectionLabel;
    const readOnlyLabel = this.readOnlyLabel;
    const editableLabel = this.editableLabel;
    const statusLabel = this.#messages.status?.[model.status] ?? model.status;
    const readOnlyReason = this.#messages.readOnlyReason;
    const readOnlyMessage =
      typeof readOnlyReason === "function"
        ? readOnlyReason(model.capabilities.reason)
        : (readOnlyReason ?? model.capabilities.reason ?? readOnlyLabel);
    this.setShadowHtml(`
      <style>${baseStyles()}${editorStyles()}</style>
      <section class="editor" part="panel" aria-label="${escapeHtml(label)}">
        <div class="editor__bar">
          <h2>${escapeHtml(label)}</h2>
          <span data-status>${escapeHtml(statusLabel)}</span>
        </div>
        <p class="selection">${escapeHtml(selected?.title ?? noSelectionLabel)}</p>
        <p class="muted">${escapeHtml(model.capabilities.readOnly ? readOnlyMessage : editableLabel)}</p>
        <div class="editor__actions">
          <button type="button" data-action="new" ${model.capabilities.canCreate && !model.capabilities.readOnly ? "" : "disabled"}>${escapeHtml(newLabel)}</button>
          <button type="button" data-action="save" ${canUpdate ? "" : "disabled"}>${escapeHtml(saveLabel)}</button>
          <button type="button" data-action="delete" ${model.capabilities.canDelete && !model.capabilities.readOnly ? "" : "disabled"}>${escapeHtml(deleteLabel)}</button>
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

export class HonuaBasemapControlElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #activeBasemapId: string | undefined;

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Basemaps";
    const basemaps = basemapsFromState(this.state);
    const active = this.#activeBasemapId ?? basemaps.find((basemap) => basemap.visible)?.id ?? basemaps[0]?.id;
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}${basemapControlStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(basemaps.length >= 2 ? "ready" : "unsupported")}</span>
        </div>
        ${
          basemaps.length < 2
            ? `<p class="empty" role="status">At least two basemap layers are required.</p>`
            : `<div class="segmented" role="group" aria-label="${escapeAttribute(label)}">
              ${basemaps
                .map(
                  (basemap) => `
                <button type="button" data-basemap-id="${escapeAttribute(basemap.id)}" aria-pressed="${String(
                  basemap.id === active,
                )}">${escapeHtml(basemap.title)}</button>
              `,
                )
                .join("")}
            </div>`
        }
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-basemap-id]").forEach((button) => {
      button.addEventListener("click", () => this.selectBasemap(button.dataset.basemapId));
    });
  }

  private selectBasemap(basemapId: string | undefined): void {
    if (!basemapId) return;
    const previousBasemapId = this.#activeBasemapId;
    this.#activeBasemapId = basemapId;
    for (const basemap of basemapsFromState(this.state)) {
      this.controller?.setLayerVisibility(basemap.id, basemap.id === basemapId);
    }
    this.dispatchTypedEvent<HonuaBasemapChangeDetail>("honua-basemap-change", {
      basemapId,
      ...(previousBasemapId ? { previousBasemapId } : {}),
      status: "ready",
    });
    this.render();
  }
}

export class HonuaBookmarksElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label", "bookmarks"];
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Bookmarks";
    const bookmarks = this.bookmarks();
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(bookmarks.length > 0 ? "ready" : "unsupported")}</span>
        </div>
        ${
          bookmarks.length === 0
            ? `<p class="empty" role="status">No initial view or bookmarks are available.</p>`
            : `<div class="button-stack">
              ${bookmarks
                .map(
                  (bookmark) => `
                <button type="button" data-bookmark-id="${escapeAttribute(bookmark.id)}">${escapeHtml(
                  bookmark.label,
                )}</button>
              `,
                )
                .join("")}
            </div>`
        }
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-bookmark-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const bookmark = this.bookmarks().find((candidate) => candidate.id === button.dataset.bookmarkId);
        if (bookmark) this.goToBookmark(bookmark);
      });
    });
  }

  private bookmarks(): readonly HonuaBookmark[] {
    const configured = parseBookmarks(this.getAttribute("bookmarks"));
    const home = this.state?.mapPackage?.initialView;
    return [...(home ? [{ id: "home", label: "Home", viewport: home } satisfies HonuaBookmark] : []), ...configured];
  }

  private goToBookmark(bookmark: HonuaBookmark): void {
    this.controller?.setViewport(bookmark.viewport);
    this.dispatchTypedEvent<HonuaBookmarkChangeDetail>("honua-bookmark-change", {
      ...bookmark,
      status: "ready",
    });
    this.dispatchTypedEvent<HonuaViewportChangeDetail>("honua-viewport-change", bookmark.viewport);
  }
}

export class HonuaLocateControlElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label", "latitude", "longitude", "zoom"];
  }

  #status: HonuaComponentStatus = "idle";
  #message = "";
  #messages: HonuaLocateControlMessages = {};

  /** Caller-supplied localized labels and state messages. */
  public get messages(): HonuaLocateControlMessages {
    return this.#messages;
  }

  public set messages(messages: HonuaLocateControlMessages | undefined) {
    this.#messages = messages ?? {};
    this.render();
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Locate";
    const supported = this.hasConfiguredLocation() || Boolean(globalThis.navigator?.geolocation);
    const status = supported ? this.#status : "unsupported";
    const statusLabel = this.#messages.status?.[status] ?? status;
    const message =
      this.#message ||
      (supported
        ? (this.#messages.initial ?? "Centers the shared map controller.")
        : (this.#messages.unavailable ?? "Geolocation is unavailable."));
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(statusLabel)}</span>
        </div>
        <button type="button" data-locate="action" ${supported ? "" : "disabled"}>${escapeHtml(
          this.#messages.actionLabel ?? "Use location",
        )}</button>
        <p class="empty" role="status">${escapeHtml(message)}</p>
      </section>
    `);
    this.shadowRoot?.querySelector<HTMLButtonElement>("button[data-locate]")?.addEventListener("click", () => {
      void this.locate();
    });
  }

  private async locate(): Promise<void> {
    const configured = this.configuredViewport();
    if (configured) {
      this.applyLocation(configured);
      return;
    }
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation) {
      this.#status = "unsupported";
      this.#message = this.#messages.unavailable ?? "Geolocation is unavailable.";
      this.dispatchTypedEvent<HonuaLocateChangeDetail>("honua-locate-change", {
        status: "unsupported",
        message: this.#message,
      });
      this.render();
      return;
    }
    this.#status = "loading";
    this.#message = this.#messages.requesting ?? "Requesting location.";
    this.render();
    geolocation.getCurrentPosition(
      (position) => {
        this.applyLocation({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: this.zoom(),
        });
      },
      (error) => {
        this.#status = "error";
        this.#message = this.#messages.error?.(error) ?? error.message;
        this.dispatchTypedEvent<HonuaLocateChangeDetail>("honua-locate-change", {
          status: "error",
          error,
          message: error.message,
        });
        this.render();
      },
    );
  }

  private applyLocation(viewport: HonuaViewportState): void {
    this.#status = "ready";
    this.#message = this.#messages.applied ?? "Location applied.";
    this.controller?.setViewport(viewport);
    this.dispatchTypedEvent<HonuaLocateChangeDetail>("honua-locate-change", { status: "ready", viewport });
    this.dispatchTypedEvent<HonuaViewportChangeDetail>("honua-viewport-change", viewport);
    this.render();
  }

  private hasConfiguredLocation(): boolean {
    return this.configuredViewport() !== undefined;
  }

  private configuredViewport(): HonuaViewportState | undefined {
    const latitude = Number(this.getAttribute("latitude"));
    const longitude = Number(this.getAttribute("longitude"));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
    return { center: [longitude, latitude], zoom: this.zoom() };
  }

  private zoom(): number {
    const zoom = Number(this.getAttribute("zoom"));
    return Number.isFinite(zoom) ? zoom : 14;
  }
}

/**
 * `<honua-measure-control>` renders distance/area measuring modes.
 *
 * The control is only interactive when the controller has a measurement
 * geometry provider configured (`measurementGeometry` on
 * {@link CreateHonuaWebComponentControllerOptions}). Without one — for example
 * the bare in-memory controller — the modes render disabled with a "configure
 * a provider" affordance, by design: the SDK does not bundle a drawing backend.
 */
export class HonuaMeasureControlElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #mode: HonuaMeasureMode = "off";

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected controllerChanged(): void {
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Measure";
    const enabled = this.controller?.canMeasure() ?? false;
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(enabled ? "ready" : "unsupported")}</span>
        </div>
        <div class="segmented" role="group" aria-label="${escapeAttribute(label)}">
          ${(["off", "distance", "area"] as const)
            .map(
              (mode) => `
            <button type="button" data-measure-mode="${mode}" aria-pressed="${String(
              this.#mode === mode,
            )}"${enabled ? "" : ' aria-disabled="true" disabled'}>${escapeHtml(modeLabel(mode))}</button>
          `,
            )
            .join("")}
        </div>
        ${
          enabled
            ? ""
            : `<p class="empty" role="status">Measurement is disabled because no geometry provider is configured. Pass a \`measurementGeometry\` provider to the controller to enable distance and area measuring.</p>`
        }
      </section>
    `);
    if (!enabled) return;
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-measure-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        void this.setMode((button.dataset.measureMode ?? "off") as HonuaMeasureMode);
      });
    });
  }

  private async setMode(mode: HonuaMeasureMode): Promise<void> {
    this.#mode = mode;
    const detail = this.controller
      ? await this.controller.setMeasureMode(mode)
      : {
          mode,
          status: "unsupported" as HonuaComponentStatus,
          message:
            "Measurement requires a geometry provider. Configure `measurementGeometry` on the controller to enable measuring.",
        };
    this.dispatchTypedEvent<HonuaMeasureChangeDetail>("honua-measure-change", detail);
    this.render();
  }
}

/**
 * `<honua-sketch-control>` renders point/line/polygon drawing modes.
 *
 * Like {@link HonuaMeasureControlElement}, the control is only interactive when
 * the controller has a sketch geometry provider configured (`sketchGeometry` on
 * {@link CreateHonuaWebComponentControllerOptions}). Without one the modes
 * render disabled with a "configure a provider" affordance.
 */
export class HonuaSketchControlElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label"];
  }

  #mode: HonuaSketchMode = "off";

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected controllerChanged(): void {
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Sketch";
    const enabled = this.controller?.canSketch() ?? false;
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(enabled ? "ready" : "unsupported")}</span>
        </div>
        <div class="segmented" role="group" aria-label="${escapeAttribute(label)}">
          ${(["off", "point", "line", "polygon"] as const)
            .map(
              (mode) => `
            <button type="button" data-sketch-mode="${mode}" aria-pressed="${String(
              this.#mode === mode,
            )}"${enabled ? "" : ' aria-disabled="true" disabled'}>${escapeHtml(modeLabel(mode))}</button>
          `,
            )
            .join("")}
        </div>
        ${
          enabled
            ? ""
            : `<p class="empty" role="status">Sketching is disabled because no geometry provider is configured. Pass a \`sketchGeometry\` provider to the controller to enable point, line, and polygon drawing.</p>`
        }
      </section>
    `);
    if (!enabled) return;
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-sketch-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        void this.setMode((button.dataset.sketchMode ?? "off") as HonuaSketchMode);
      });
    });
  }

  private async setMode(mode: HonuaSketchMode): Promise<void> {
    this.#mode = mode;
    const detail = this.controller
      ? await this.controller.setSketchMode(mode)
      : {
          mode,
          status: "unsupported" as HonuaComponentStatus,
          message:
            "Sketching requires a geometry provider. Configure `sketchGeometry` on the controller to enable drawing.",
        };
    this.dispatchTypedEvent<HonuaSketchChangeDetail<T>>("honua-sketch-change", detail);
    this.render();
  }
}

/** Legacy `honua-export` event `format` label for each export kind. */
const EXPORT_FORMAT_BY_KIND: Readonly<Record<HonuaExportKind, HonuaExportDetail["format"]>> = {
  print: "print",
  snapshot: "png",
  state: "json",
};

const EXPORT_KIND_BY_FORMAT: Readonly<Record<HonuaExportDetail["format"], HonuaExportKind>> = {
  print: "print",
  png: "snapshot",
  json: "state",
};

/** Maps an export outcome onto the shared component-status vocabulary. */
const EXPORT_COMPONENT_STATUS: Readonly<Record<HonuaExportStatus, HonuaComponentStatus>> = {
  ready: "ready",
  unsupported: "unsupported",
  cancelled: "idle",
  error: "error",
};

/**
 * `<honua-print-export>` — print, snapshot, and sanitized state export.
 *
 * Assign {@link HonuaPrintExportElement.exportAdapter} to enable snapshot and
 * state export. Without an adapter both **fail closed** (issue #683): the
 * buttons render disabled with an explanation, and a programmatic
 * `requestExport()` resolves to an `unsupported` result carrying a
 * `HonuaCapabilityNotSupportedError` — never a blank image or a
 * partially-credentialed JSON document. Browser print keeps working with no
 * adapter, because `window.print()` reads no pixels and serializes no state.
 */
export class HonuaPrintExportElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  #exportAdapter: HonuaExportAdapter | undefined;
  #lastResult: HonuaExportResult | undefined;
  #inFlight: AbortController | undefined;
  /** Monotonic request generation; only the newest export may publish. */
  #exportGeneration = 0;

  static get observedAttributes(): string[] {
    return ["for", "label", "title"];
  }

  /**
   * The application-supplied export adapter. Setting it re-renders so the
   * snapshot/state affordances become enabled; clearing it re-disables them.
   */
  public get exportAdapter(): HonuaExportAdapter | undefined {
    return this.#exportAdapter;
  }

  public set exportAdapter(adapter: HonuaExportAdapter | undefined) {
    if (this.#exportAdapter === adapter) return;
    this.#exportAdapter = adapter;
    this.render();
  }

  /** The most recent export result, for callers that prefer polling to events. */
  public get lastExportResult(): HonuaExportResult | undefined {
    return this.#lastResult;
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  public disconnectedCallback(): void {
    // An in-flight export outlives nothing: disconnecting cancels it so a
    // detached element cannot keep an adapter (or a server-side render job)
    // alive (REQ-005 deterministic disposal).
    this.#inFlight?.abort();
    this.#inFlight = undefined;
    // Bump the generation too: an abort-ignoring adapter's continuation must
    // not publish onto a detached element either.
    this.#exportGeneration += 1;
    super.disconnectedCallback();
  }

  /** Kinds that are actually available right now, given the assigned adapter. */
  public availableExportKinds(): readonly HonuaExportKind[] {
    const adapter = this.#resolveAdapter();
    if (!adapter) return [];
    try {
      return adapter.describeCapabilities().kinds.filter((kind) => HONUA_EXPORT_KINDS.includes(kind));
    } catch {
      return [];
    }
  }

  /**
   * Runs one export. Resolves with the full result envelope (never throws) and
   * dispatches `honua-export` with a redacted projection of it.
   */
  public async requestExport(kind: HonuaExportKind): Promise<HonuaExportResult> {
    this.#inFlight?.abort();
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    this.#inFlight = controller;
    // An AbortSignal is advisory: an adapter is free to ignore it and settle
    // later, so aborting the previous export does not guarantee it stays quiet.
    // Ownership of the element's visible state therefore belongs to a
    // generation, not to a controller — a completion that no longer owns the
    // element neither publishes a result nor dispatches an event, so a slow
    // first export cannot overwrite a newer one that already finished.
    this.#exportGeneration += 1;
    const generation = this.#exportGeneration;
    const title = this.getAttribute("title") ?? this.state?.packageId ?? undefined;
    const result = await runHonuaExport<T>({
      kind,
      adapter: this.#resolveAdapter(kind),
      state: this.state,
      ...(title ? { title } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (this.#inFlight === controller) this.#inFlight = undefined;
    if (generation !== this.#exportGeneration) {
      // Superseded. The caller still gets its own result — it asked for this
      // export and is entitled to the outcome — but the element does not adopt
      // it, and any resource the adapter handed back is released here, since
      // nothing else now holds a reference to release it.
      void result.release();
      return result;
    }
    this.#lastResult = result;
    this.dispatchTypedEvent<HonuaExportDetail>("honua-export", exportDetailFromResult(result, title));
    this.render();
    return result;
  }

  /**
   * Resolves the adapter for `kind`. The built-in browser-print adapter is used
   * for `print` only when the application supplied nothing — snapshot and state
   * have no built-in fallback by design.
   */
  #resolveAdapter(kind?: HonuaExportKind): HonuaExportAdapter | undefined {
    if (this.#exportAdapter) return this.#exportAdapter;
    if (kind !== undefined && kind !== "print") return undefined;
    const printAdapter = createBrowserPrintExportAdapter();
    return printAdapter.describeCapabilities().kinds.length > 0 ? printAdapter : undefined;
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Print and export";
    const available = new Set(this.availableExportKinds());
    const status = available.size === 0 ? "unsupported" : "ready";
    const last = this.#lastResult;
    const buttons = (["print", "snapshot", "state"] as const)
      .map((kind) => {
        const enabled = available.has(kind);
        const title = enabled
          ? `${EXPORT_LABELS[kind]} export`
          : `${EXPORT_LABELS[kind]} export requires an application-supplied export adapter.`;
        // Deliberately neither `disabled` nor `aria-disabled`, even when no
        // adapter is assigned. Both suppress activation — assistive technology
        // skips a disabled control, and Playwright treats either as
        // non-actionable — which would silence the `honua-export` event that is
        // how an application *discovers* it must supply an adapter. The
        // unavailability is conveyed where it can still be read and acted on:
        // an explanatory `title` on the control and the live-region readout
        // below. Fail-closed is unaffected — activating it runs the export,
        // which returns `unsupported` with no bytes.
        return `<button type="button" data-export-format="${EXPORT_FORMAT_BY_KIND[kind]}" data-export-kind="${kind}"${
          enabled ? "" : ' data-export-unavailable="true"'
        } title="${escapeHtml(title)}">${escapeHtml(EXPORT_LABELS[kind])}</button>`;
      })
      .join("");
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(status)}</span>
        </div>
        <div class="button-stack">${buttons}</div>
        <p part="status" role="status" aria-live="polite">${escapeHtml(exportStatusText(last, available))}</p>
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-export-kind]").forEach((button) => {
      button.addEventListener("click", () => {
        void this.requestExport(button.dataset.exportKind as HonuaExportKind);
      });
    });
  }
}

const EXPORT_LABELS: Readonly<Record<HonuaExportKind, string>> = {
  print: "Print",
  snapshot: "Snapshot",
  state: "State JSON",
};

/**
 * Redacted, displayable summary of the last export attempt — or, before any
 * attempt, an honest statement of what is actually available. The
 * adapter-required message is keyed on snapshot/state specifically, not on
 * "nothing is available": browser print is available with no adapter, and
 * reporting "ready to export" while two of the three buttons are inert would be
 * exactly the kind of quiet degradation issue #683 exists to remove.
 */
function exportStatusText(result: HonuaExportResult | undefined, available: ReadonlySet<HonuaExportKind>): string {
  if (!result) {
    if (available.has("snapshot") && available.has("state")) return "Ready to export.";
    return available.size === 0
      ? "Assign an export adapter to enable export."
      : "Assign an export adapter to enable snapshot and state export.";
  }
  if (result.status === "ready") {
    const redacted =
      result.redactions.length > 0 ? ` ${result.redactions.length} value(s) were withheld as non-exportable.` : "";
    return result.sideEffectOnly
      ? `Print layout sent to the browser.${redacted}`
      : `Exported ${result.filename ?? "artifact"}.${redacted}`;
  }
  return result.message ?? `Export ${result.status}.`;
}

/** Projects a result onto the event detail, carrying only redacted fields. */
function exportDetailFromResult(result: HonuaExportResult, title: string | undefined): HonuaExportDetail {
  const detail: HonuaExportDetail = {
    format: EXPORT_FORMAT_BY_KIND[result.kind],
    kind: result.kind,
    status: EXPORT_COMPONENT_STATUS[result.status],
    exportStatus: result.status,
    redactionCount: result.redactions.length,
  };
  const mutable = detail as {
    title?: string;
    message?: string;
    adapterId?: string;
    filename?: string;
    mediaType?: string;
    byteLength?: number;
    errorCode?: string;
  };
  if (title) mutable.title = redactHonuaExportText(title);
  if (result.message) mutable.message = result.message;
  if (result.adapterId) mutable.adapterId = result.adapterId;
  if (result.filename) mutable.filename = result.filename;
  if (result.mediaType) mutable.mediaType = result.mediaType;
  if (result.bytes) mutable.byteLength = result.bytes.byteLength;
  if (result.error) mutable.errorCode = result.error.sdkCode;
  return detail;
}

/** The `format` → export-kind mapping, exported for callers on the legacy event shape. */
export function honuaExportKindFromFormat(format: HonuaExportDetail["format"]): HonuaExportKind {
  return EXPORT_KIND_BY_FORMAT[format];
}

export class HonuaMapStatusElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label", "attribution"];
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Map status";
    const attribution = this.getAttribute("attribution") ?? this.state?.mapPackage?.mapPackageId ?? "Honua";
    this.setShadowHtml(`
      <style>${baseStyles()}${mapStatusStyles()}</style>
      <section class="map-status" part="panel" aria-label="${escapeHtml(label)}">
        <span aria-label="Approximate scale">${escapeHtml(approximateScale(this.state?.viewport))}</span>
        <span aria-label="Attribution">${escapeHtml(attribution)}</span>
        <button type="button" data-fullscreen="action">Fullscreen</button>
      </section>
    `);
    this.shadowRoot?.querySelector<HTMLButtonElement>("button[data-fullscreen]")?.addEventListener("click", () => {
      void this.toggleFullscreen();
    });
  }

  private async toggleFullscreen(): Promise<void> {
    const root = this.getRootNode?.() as Document | ShadowRoot | undefined;
    const mapId = this.getAttribute("for");
    const target = mapId ? getElementById(root, mapId) : this;
    const requestFullscreen = (target as { requestFullscreen?: () => Promise<void> } | null)?.requestFullscreen;
    if (!requestFullscreen) {
      this.dispatchTypedEvent<HonuaFullscreenChangeDetail>("honua-fullscreen-change", {
        fullscreen: false,
        status: "unsupported",
        message: "Fullscreen is unavailable.",
      });
      return;
    }
    await requestFullscreen.call(target);
    this.dispatchTypedEvent<HonuaFullscreenChangeDetail>("honua-fullscreen-change", {
      fullscreen: true,
      status: "ready",
    });
  }
}

export class HonuaActionPanelElement<T = Record<string, unknown>> extends HonuaElementBase<T> {
  static get observedAttributes(): string[] {
    return ["for", "label", "actions"];
  }

  public attributeChangedCallback(): void {
    this.resolveControllerFromContext();
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Actions";
    const actions = parseActions(this.getAttribute("actions"));
    this.setShadowHtml(`
      <style>${baseStyles()}${controlPanelStyles()}${actionPanelStyles()}</style>
      <section class="control-panel" part="panel" aria-label="${escapeHtml(label)}">
        <div class="control-panel__bar">
          <h2>${escapeHtml(label)}</h2>
          <span>${escapeHtml(actions.length > 0 ? "ready" : "unsupported")}</span>
        </div>
        ${
          actions.length === 0
            ? `<p class="empty" role="status">No actions are configured.</p>`
            : `<div class="button-stack">
              ${actions
                .map(
                  (action) => `
                <button type="button" data-action-id="${escapeAttribute(action.id)}" ${action.disabled ? "disabled" : ""}>${escapeHtml(
                  action.label,
                )}</button>
              `,
                )
                .join("")}
            </div>`
        }
      </section>
    `);
    this.shadowRoot?.querySelectorAll<HTMLButtonElement>("button[data-action-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = actions.find((candidate) => candidate.id === button.dataset.actionId);
        if (!action) return;
        this.dispatchTypedEvent<HonuaActionDetail>("honua-action", {
          ...action,
          status: action.disabled ? "unsupported" : "ready",
        });
      });
    });
  }
}

/**
 * Every tag this kit owns, keyed for both the blanket
 * {@link defineHonuaWebComponents} registration and per-tag
 * {@link defineHonuaWebComponent} lookups (and, transitively, the catalog id
 * → constructor resolution `../controls/registry.js` uses for cross-kit
 * registration). Order here is the kit's auto-registration order.
 */
const WEB_COMPONENT_ELEMENTS: ReadonlyMap<string, CustomElementConstructor> = new Map<string, CustomElementConstructor>(
  [
    ["honua-map", HonuaMapElement],
    ["honua-layer-list", HonuaLayerListElement],
    ["honua-legend", HonuaLegendElement],
    ["honua-feature-table", HonuaFeatureTableElement],
    ["honua-search", HonuaSearchElement],
    ["honua-editor", HonuaEditorElement],
    ["honua-feature-editor", HonuaFeatureEditorElement],
    ["honua-chart", HonuaChartElement],
    ["honua-basemap-control", HonuaBasemapControlElement],
    ["honua-bookmarks", HonuaBookmarksElement],
    ["honua-locate-control", HonuaLocateControlElement],
    ["honua-measure-control", HonuaMeasureControlElement],
    ["honua-measurement", HonuaMeasurementElement],
    ["honua-sketch-control", HonuaSketchControlElement],
    ["honua-print-export", HonuaPrintExportElement],
    ["honua-map-status", HonuaMapStatusElement],
    ["honua-action-panel", HonuaActionPanelElement],
  ],
);

/**
 * Registers every custom element this kit owns. Skips tags already defined.
 * Called automatically on import of `./index.js` (`@honua/sdk-js/web-components`)
 * — NOT on import of this module, which stays side-effect-free (issue #679).
 */
export function defineHonuaWebComponents(registry = globalDom.customElements): void {
  if (!registry) return;
  for (const [tagName, ctor] of WEB_COMPONENT_ELEMENTS) {
    defineIfMissing(registry, tagName, ctor);
  }
}

/**
 * Registers a single web-components tag by name (e.g. `"honua-feature-table"`).
 * Unknown tags are a no-op. Skips the registration when the tag is already
 * defined. This is the primitive the catalog-driven `registerComponent` /
 * `registerComponents` APIs in `../controls/registry.js` call for
 * `web-components`-sourced catalog entries, so a consumer can register one
 * tag from this kit without the blanket {@link defineHonuaWebComponents} call.
 */
export function defineHonuaWebComponent(tagName: string, registry = globalDom.customElements): void {
  if (!registry) return;
  const ctor = WEB_COMPONENT_ELEMENTS.get(tagName);
  if (ctor) defineIfMissing(registry, tagName, ctor);
}

function defineIfMissing(registry: CustomElementRegistry, tagName: string, ctor: CustomElementConstructor): void {
  if (!registry.get(tagName)) registry.define(tagName, ctor);
}

// Deliberately no module-load auto-registration here (issue #679 PR review):
// this module must stay side-effect-free on import so `../controls/registry.js`
// can dynamically `import()` it for single-tag registration without that
// import silently claiming every tag the kit owns. The blanket
// auto-registration importing `@honua/sdk-js/web-components` triggers lives
// in `./index.js`, which is every existing consumer's actual entry point —
// see that module for the `defineHonuaWebComponents()` call.

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

function basemapsFromState<T>(
  state: HonuaWebComponentState<T> | undefined,
): readonly { id: string; title: string; visible: boolean }[] {
  return (state?.layers ?? [])
    .filter((layer) => layer.type === "background" || layer.metadata?.basemap === true)
    .map((layer) => ({ id: layer.id, title: layer.title, visible: layer.visible }));
}

function parseBookmarks(value: string | null): readonly HonuaBookmark[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): HonuaBookmark[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<HonuaBookmark>;
      if (!candidate.id || !candidate.label || !candidate.viewport) return [];
      return [{ id: String(candidate.id), label: String(candidate.label), viewport: candidate.viewport }];
    });
  } catch {
    return [];
  }
}

function parseActions(value: string | null): readonly HonuaActionPanelAction[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): HonuaActionPanelAction[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<HonuaActionPanelAction>;
      if (!candidate.id || !candidate.label) return [];
      return [
        {
          id: String(candidate.id),
          label: String(candidate.label),
          ...(candidate.disabled ? { disabled: true } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function modeLabel(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/**
 * `<honua-map-status>`'s scale readout. Shares the single scale implementation
 * with the export pipeline's provenance block (issue #683) so a printed or
 * snapshotted map can never disagree with the scale the user saw on screen.
 */
function approximateScale(viewport: HonuaViewportState | undefined): string {
  return approximateHonuaScaleLabel(viewport) ?? "Scale unavailable";
}

function setText(element: Element | null | undefined, value: string): void {
  if (element) element.textContent = value;
}

interface FocusSnapshot {
  selector: string;
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
  selectionDirection?: "forward" | "backward" | "none";
}

function captureFocus(root: Element | ShadowRoot): FocusSnapshot | undefined {
  if (!("activeElement" in root)) return undefined;
  const active = root.activeElement;
  if (!active || !("localName" in active)) return undefined;
  const selector = focusSelector(active);
  if (!selector) return undefined;
  const textControl = isTextControl(active) ? active : undefined;
  return {
    selector,
    ...(textControl ? { value: textControl.value } : {}),
    ...(typeof textControl?.selectionStart === "number" ? { selectionStart: textControl.selectionStart } : {}),
    ...(typeof textControl?.selectionEnd === "number" ? { selectionEnd: textControl.selectionEnd } : {}),
    ...(textControl?.selectionDirection ? { selectionDirection: textControl.selectionDirection } : {}),
  };
}

function restoreFocus(root: Element | ShadowRoot, snapshot: FocusSnapshot | undefined): void {
  if (!snapshot || typeof root.querySelector !== "function") return;
  const target = root.querySelector(snapshot.selector);
  if (!target || !("focus" in target) || typeof target.focus !== "function") return;
  target.focus({ preventScroll: true });
  if (
    snapshot.value === undefined ||
    snapshot.selectionStart === undefined ||
    snapshot.selectionEnd === undefined ||
    !isTextControl(target) ||
    target.value !== snapshot.value
  ) {
    return;
  }
  target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection ?? "none");
}

function focusSelector(element: Element): string | undefined {
  const tagName = element.localName;
  for (const name of ["id", "name"]) {
    const value = element.getAttribute(name);
    if (value) return `${tagName}[${name}="${cssAttribute(value)}"]`;
  }
  for (const name of element
    .getAttributeNames()
    .filter((attribute) => attribute.startsWith("data-"))
    .sort()) {
    const value = element.getAttribute(name);
    if (value) return `${tagName}[${name}="${cssAttribute(value)}"]`;
  }
  return undefined;
}

function isTextControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    (element.localName === "input" || element.localName === "textarea") &&
    "value" in element &&
    "setSelectionRange" in element
  );
}

function cssAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function browserOrigin(): string {
  return typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost";
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
      overflow: hidden;
      position: relative;
    }
    .map__renderer {
      height: 100%;
      inset: 0;
      min-height: inherit;
      position: absolute;
      width: 100%;
    }
    .map__renderer.maplibregl-map,
    .map__renderer .maplibregl-map,
    .map__renderer .maplibregl-canvas-container,
    .map__renderer .maplibregl-canvas {
      height: 100%;
      width: 100%;
    }
    .map__renderer .maplibregl-canvas-container {
      inset: 0;
      position: absolute;
    }
    .map__renderer .maplibregl-canvas {
      left: 0;
      position: absolute;
      top: 0;
    }
    .map__status {
      background: rgba(255,255,255,0.86);
      border-radius: 6px;
      color: var(--honua-ui-muted);
      left: 10px;
      padding: 4px 7px;
      position: absolute;
      top: 10px;
      z-index: 1;
    }
    .map__status:empty { display: none; }
    .maplibregl-ctrl-attrib,
    .maplibregl-control-container {
      display: none;
    }
    @media (forced-colors: active), (prefers-contrast: more) {
      .map {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .map__chrome, .map__footer, .map__status {
        background: Canvas;
        color: CanvasText;
      }
      .map__canvas { background: Canvas; }
      .map__controls button { border-color: ButtonText; color: ButtonText; }
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

function legendStyles(): string {
  return `
    @media (forced-colors: active), (prefers-contrast: more) {
      .legend li { color: CanvasText; }
      .legend .swatch {
        background: Canvas;
        border: 2px solid CanvasText;
        forced-color-adjust: none;
      }
    }
  `;
}

function layerListStyles(): string {
  return `
    .layer-row {
      border-top: 1px solid transparent;
      display: grid;
      gap: 4px;
    }
    .layer-row[draggable="true"] { cursor: grab; }
    .layer-row__tools {
      align-items: center;
      display: flex;
      gap: 6px;
      padding-left: 24px;
    }
    .opacity { flex: 1; min-width: 60px; }
    .move { min-width: 32px; padding: 0; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .layer-row {
        border-top-color: CanvasText;
      }
      .layer-row input[type="checkbox"]:checked + span {
        color: Highlight;
      }
      .layer-row__tools button {
        border-color: ButtonText;
      }
    }
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
    @media (forced-colors: active), (prefers-contrast: more) {
      .table-panel {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .table-panel__bar, th { background: Canvas; color: CanvasText; }
      th, td { border-top-color: CanvasText; }
      tr[aria-selected="true"] td { background: Highlight; color: HighlightText; }
      tbody tr[data-feature-id]:focus { outline-color: Highlight; }
    }
  `;
}

function searchStyles(): string {
  return `
    .search {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      min-width: 0;
      padding: 10px;
      width: 100%;
    }
    form { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; min-width: 0; }
    input {
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      min-height: 32px;
      min-width: 0;
      padding: 0 9px;
    }
    .results { display: grid; gap: 6px; list-style: none; margin: 10px 0 0; padding: 0; }
    .results button { text-align: left; width: 100%; }
    .suggestions {
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      display: grid;
      list-style: none;
      margin: 6px 0 0;
      overflow: hidden;
      padding: 0;
    }
    .suggestions[hidden] { display: none; }
    .suggestions [role="option"] { cursor: pointer; padding: 6px 9px; }
    .suggestions [role="option"][aria-selected="true"] {
      background: var(--honua-ui-accent);
      color: var(--honua-ui-accent-fg);
    }
    .status { color: var(--honua-ui-muted); margin: 6px 0 0; }
    .status:empty { display: none; }
    @media (max-width: 320px) {
      form { grid-template-columns: minmax(0, 1fr); }
      form button { width: 100%; }
    }
    @media (forced-colors: active), (prefers-contrast: more) {
      .search, input, button, .suggestions { border-color: CanvasText; }
      .suggestions [role="option"][aria-selected="true"] {
        background: Highlight;
        color: HighlightText;
      }
    }
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
    @media (forced-colors: active), (prefers-contrast: more) {
      .editor {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .editor__actions button {
        border-color: ButtonText;
        color: ButtonText;
      }
    }
    @media (max-width: 320px) {
      .editor { min-width: 0; }
      .editor__actions { flex-wrap: wrap; }
      .editor__actions button { flex: 1 1 120px; min-width: 0; }
    }
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
    @media (forced-colors: active), (prefers-contrast: more) {
      .chart {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .bar { background: ButtonFace; outline: 1px solid ButtonText; }
      .bar::before { background: Highlight; }
    }
  `;
}

function controlPanelStyles(): string {
  return `
    .control-panel {
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: grid;
      gap: 10px;
      min-width: 180px;
      padding: 10px;
    }
    .control-panel__bar {
      align-items: center;
      display: flex;
      gap: 8px;
      justify-content: space-between;
    }
    .control-panel__bar span {
      color: var(--honua-ui-muted);
      font-size: 12px;
    }
    .button-stack {
      display: grid;
      gap: 6px;
    }
    .button-stack button {
      justify-content: flex-start;
      text-align: left;
    }
    .segmented {
      display: grid;
      gap: 6px;
      grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
    }
    .segmented button {
      min-width: 0;
      padding: 0 8px;
    }
    button[aria-pressed="true"] {
      background: var(--honua-ui-accent);
      border-color: var(--honua-ui-accent);
      color: var(--honua-ui-accent-fg);
    }
    p {
      margin: 0;
    }
    @media (max-width: 240px) {
      .control-panel {
        min-width: 0;
      }
      .control-panel__bar {
        align-items: flex-start;
        flex-direction: column;
      }
      .control-panel__bar h2 {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .segmented {
        grid-template-columns: 1fr;
      }
      .button-stack button,
      .segmented button,
      .control-panel > button {
        width: 100%;
      }
    }
    @media (forced-colors: active), (prefers-contrast: more) {
      .control-panel {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .control-panel__bar span { color: CanvasText; }
      .button-stack button {
        background: ButtonFace;
        border-color: ButtonText;
        color: ButtonText;
      }
    }
  `;
}

function basemapControlStyles(): string {
  return `
    @media (forced-colors: active), (prefers-contrast: more) {
      .control-panel {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .control-panel__bar span, .empty { color: CanvasText; }
      .segmented button {
        background: ButtonFace;
        border: 2px solid ButtonText;
        color: ButtonText;
        forced-color-adjust: none;
      }
      .segmented button[aria-pressed="true"] {
        background: Highlight;
        border-color: Highlight;
        color: HighlightText;
      }
      .segmented button:focus-visible {
        outline: 2px solid Highlight;
        outline-offset: 2px;
      }
    }
  `;
}

function actionPanelStyles(): string {
  return `
    @media (forced-colors: active), (prefers-contrast: more) {
      .control-panel {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .control-panel__bar span, .empty { color: CanvasText; }
      .button-stack button {
        background: ButtonFace;
        border: 2px solid ButtonText;
        color: ButtonText;
        forced-color-adjust: none;
      }
      .button-stack button:disabled {
        border-color: GrayText;
        color: GrayText;
      }
    }
  `;
}

function mapStatusStyles(): string {
  return `
    .map-status {
      align-items: center;
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: flex;
      direction: inherit;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: space-between;
      min-height: 42px;
      padding-block: 6px;
      padding-inline: 8px;
    }
    span {
      color: var(--honua-ui-muted);
      min-width: 0;
      text-align: start;
    }
    .map-status button { text-align: start; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .map-status {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .map-status span { color: CanvasText; }
      .map-status button {
        background: ButtonFace;
        border: 2px solid ButtonText;
        color: ButtonText;
        forced-color-adjust: none;
      }
      :host([data-status="unsupported"]) .map-status {
        border-color: GrayText;
        color: GrayText;
      }
      :host([data-status="unsupported"]) .map-status span { color: GrayText; }
      :host([data-status="error"]) .map-status {
        border-color: Mark;
        color: MarkText;
      }
      :host([data-status="error"]) .map-status span { color: MarkText; }
    }
    @media (max-width: 240px) {
      .map-status { align-items: flex-start; flex-direction: column; }
      .map-status button { inline-size: 100%; }
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
    "honua-feature-editor": HonuaFeatureEditorElement;
    "honua-chart": HonuaChartElement;
    "honua-basemap-control": HonuaBasemapControlElement;
    "honua-bookmarks": HonuaBookmarksElement;
    "honua-locate-control": HonuaLocateControlElement;
    "honua-measure-control": HonuaMeasureControlElement;
    "honua-measurement": HonuaMeasurementElement;
    "honua-sketch-control": HonuaSketchControlElement;
    "honua-print-export": HonuaPrintExportElement;
    "honua-map-status": HonuaMapStatusElement;
    "honua-action-panel": HonuaActionPanelElement;
  }

  interface HTMLElementEventMap {
    "honua-controller-ready": CustomEvent<HonuaControllerReadyDetail>;
    "honua-map-ready": CustomEvent<HonuaMapReadyDetail>;
    "honua-map-error": CustomEvent<HonuaMapErrorDetail>;
    "honua-map-click": CustomEvent<HonuaMapClickDetail>;
    "honua-map-hover": CustomEvent<HonuaMapHoverDetail>;
    "honua-layer-visibility-change": CustomEvent<HonuaLayerVisibilityChangeDetail>;
    "honua-layer-opacity-change": CustomEvent<HonuaLayerOpacityChangeDetail>;
    "honua-layer-order-change": CustomEvent<HonuaLayerOrderChangeDetail>;
    "honua-geocode-select": CustomEvent<HonuaGeocodeSelectDetail>;
    "honua-selection-change": CustomEvent<HonuaSelectionChangeDetail>;
    "honua-viewport-change": CustomEvent<HonuaViewportChangeDetail>;
    "honua-filter-change": CustomEvent<HonuaFilterChangeDetail>;
    "honua-search": CustomEvent<HonuaSearchDetail>;
    "honua-edit-change": CustomEvent<HonuaEditChangeDetail>;
    "honua-feature-edit-change": CustomEvent<HonuaFeatureEditChangeDetail>;
    "honua-feature-edit-commit": CustomEvent<HonuaFeatureEditCommitDetail>;
    "honua-basemap-change": CustomEvent<HonuaBasemapChangeDetail>;
    "honua-bookmark-change": CustomEvent<HonuaBookmarkChangeDetail>;
    "honua-locate-change": CustomEvent<HonuaLocateChangeDetail>;
    "honua-measure-change": CustomEvent<HonuaMeasureChangeDetail>;
    "honua-sketch-change": CustomEvent<HonuaSketchChangeDetail>;
    "honua-export": CustomEvent<HonuaExportDetail>;
    "honua-fullscreen-change": CustomEvent<HonuaFullscreenChangeDetail>;
    "honua-action": CustomEvent<HonuaActionDetail>;
  }
}
