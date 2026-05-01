import {
  CompatEventBus,
  type CompatEventSubscription,
  resolveCompatEventBus,
  safeInvokeCompatListener,
} from "./event-bus.js";

/** Structural type for viewpoint-like objects used by controls. */
export interface ControlViewpointLike {
  targetGeometry?: Record<string, unknown>;
  scale?: number;
  rotation?: number;
}

export interface HomeCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
  viewpoint?: HomeViewpointCompat;
}

export interface HomeViewpointCompat {
  center?: unknown;
  zoom?: number;
}

export type ControlLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface ControlHandleCompat {
  remove(): void;
}

// ---------------------------------------------------------------------------
// Base class – shared logic for all control compat classes
// ---------------------------------------------------------------------------

interface BaseControlCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
}

export class BaseControlCompat {
  public readonly view: unknown;
  public readonly container: HTMLElement | string | null;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: ControlLoadStatusCompat;

  protected readonly subscriptions: CompatEventSubscription[];
  private readonly watchListeners: Map<string, Set<(value: any) => void>>;

  protected constructor(options: BaseControlCompatOptions, ...extraEventBusCandidates: unknown[]) {
    this.view = options.view;
    this.container = options.container ?? null;
    this.eventBus =
      options.eventBus ?? resolveCompatEventBus(options.view, ...extraEventBusCandidates) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.watchListeners = new Map();
    this.subscriptions = [];
  }

  /**
   * Subclasses override to provide the event-name prefix used in load(), e.g.
   * `"home"` yields `"home.loading"` / `"home.loaded"`.
   */
  protected get controlName(): string {
    return "control";
  }

  public async load(): Promise<this> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit(`${this.controlName}.loading`, undefined, this);
    this.onLoad();
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit(`${this.controlName}.loaded`, undefined, this);
    return this;
  }

  /** Hook for subclasses to perform work during load (e.g. ScaleBarCompat.refresh). */
  protected onLoad(): void {
    // default: no-op
  }

  public async when(callback?: (widget: this) => void): Promise<this> {
    const widget = await this.load();
    if (callback) {
      callback(widget);
    }
    return widget;
  }

  public watch(propertyName: "visible", listener: (value: boolean) => void): ControlHandleCompat;
  public watch(propertyName: "disabled", listener: (value: boolean) => void): ControlHandleCompat;
  public watch(propertyName: "loaded", listener: (value: boolean) => void): ControlHandleCompat;
  public watch(propertyName: "loadStatus", listener: (value: ControlLoadStatusCompat) => void): ControlHandleCompat;
  public watch(propertyName: string, listener: (value: unknown) => void): ControlHandleCompat;
  public watch(propertyName: string, listener: (value: any) => void): ControlHandleCompat {
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

  public destroy(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.remove();
    }
    this.watchListeners.clear();
  }

  protected notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

// ---------------------------------------------------------------------------
// HomeCompat
// ---------------------------------------------------------------------------

export class HomeCompat extends BaseControlCompat {
  public viewpoint: HomeViewpointCompat;

  protected override get controlName(): string {
    return "home";
  }

  public constructor(options: HomeCompatOptions = {}) {
    super(options);
    this.viewpoint = options.viewpoint ?? {
      center: extractViewCenter(options.view),
      zoom: extractViewZoom(options.view),
    };
  }

  public async go(): Promise<void> {
    const target = {
      center: this.viewpoint.center,
      zoom: this.viewpoint.zoom,
    };

    if (isGoToProvider(this.view)) {
      await this.view.goTo(target);
    } else {
      setViewCenterZoom(this.view, target);
    }

    this.eventBus.emit("home.go", target, this);
  }

  public reset(): void {
    this.viewpoint = {
      center: extractViewCenter(this.view),
      zoom: extractViewZoom(this.view),
    };
    this.notifyWatchers("viewpoint", this.viewpoint);
    this.eventBus.emit("home.reset", this.viewpoint, this);
  }
}

// ---------------------------------------------------------------------------
// BasemapToggleCompat
// ---------------------------------------------------------------------------

export interface BasemapToggleCompatOptions {
  view?: unknown;
  map?: unknown;
  container?: HTMLElement | string | null;
  nextBasemap?: unknown;
  eventBus?: CompatEventBus;
}

export class BasemapToggleCompat extends BaseControlCompat {
  public readonly map: unknown;
  public activeBasemap: unknown;
  public nextBasemap: unknown;

  protected override get controlName(): string {
    return "basemap-toggle";
  }

  public constructor(options: BasemapToggleCompatOptions = {}) {
    const map = options.map ?? extractViewMap(options.view);
    super({ view: options.view, container: options.container, eventBus: options.eventBus }, map);
    this.map = map;
    this.activeBasemap = extractMapBasemap(this.map);
    this.nextBasemap = options.nextBasemap;
    this.subscriptions.push(
      this.eventBus.on("map.basemap-changed", (event) => {
        this.activeBasemap = extractPayloadBasemap(event.payload);
        this.notifyWatchers("activeBasemap", this.activeBasemap);
      }),
    );
  }

  public toggle(): unknown {
    const currentMap = this.map;
    if (!isRecord(currentMap)) {
      return undefined;
    }

    const previous = currentMap.basemap;
    setMapBasemap(currentMap, this.nextBasemap, this.eventBus, this);
    this.activeBasemap = extractMapBasemap(currentMap);
    this.notifyWatchers("activeBasemap", this.activeBasemap);
    this.nextBasemap = previous;
    this.notifyWatchers("nextBasemap", this.nextBasemap);
    this.eventBus.emit(
      "basemap.toggle",
      {
        activeBasemap: this.activeBasemap,
        nextBasemap: this.nextBasemap,
      },
      this,
    );
    return this.activeBasemap;
  }
}

// ---------------------------------------------------------------------------
// ScaleBarCompat
// ---------------------------------------------------------------------------

export type ScaleBarUnitCompat = "metric" | "imperial" | "dual";

export interface ScaleBarCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  unit?: ScaleBarUnitCompat;
  eventBus?: CompatEventBus;
}

export class ScaleBarCompat extends BaseControlCompat {
  public unit: ScaleBarUnitCompat;
  public scale: number | undefined;
  public text: string;

  protected override get controlName(): string {
    return "scalebar";
  }

  public constructor(options: ScaleBarCompatOptions = {}) {
    super(options);
    this.unit = options.unit ?? "metric";
    this.scale = undefined;
    this.text = "";
    this.subscriptions.push(
      this.eventBus.on("view.go-to", () => {
        this.refresh();
      }),
    );
    this.refresh();
  }

  protected override onLoad(): void {
    this.refresh();
  }

  public refresh(): string {
    const zoom = extractViewZoom(this.view);
    if (zoom === undefined) {
      this.scale = undefined;
      this.notifyWatchers("scale", this.scale);
      this.text = "";
      this.notifyWatchers("text", this.text);
      return this.text;
    }

    const mapScale = 591657527.591555 / 2 ** zoom;
    this.scale = mapScale;
    this.notifyWatchers("scale", this.scale);
    this.text = buildScaleBarText(mapScale, this.unit);
    this.notifyWatchers("text", this.text);
    this.eventBus.emit("scalebar.updated", { scale: mapScale, text: this.text, unit: this.unit }, this);
    return this.text;
  }
}

// ---------------------------------------------------------------------------
// LocateCompat
// ---------------------------------------------------------------------------

export interface LocateCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
  zoom?: number;
  locateProvider?: () => Promise<LocatePositionCompat>;
}

export interface LocatePositionCompat {
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

export class LocateCompat extends BaseControlCompat {
  public readonly zoom: number | undefined;
  public lastPosition: LocatePositionCompat | undefined;

  private readonly locateProvider: () => Promise<LocatePositionCompat>;

  protected override get controlName(): string {
    return "locate";
  }

  public constructor(options: LocateCompatOptions = {}) {
    super(options);
    this.zoom = options.zoom;
    this.lastPosition = undefined;
    this.locateProvider = options.locateProvider ?? getDefaultLocateProvider();
  }

  public async locate(): Promise<LocatePositionCompat> {
    this.eventBus.emit("locate.start", undefined, this);

    try {
      const position = await this.locateProvider();
      this.lastPosition = position;
      this.notifyWatchers("lastPosition", this.lastPosition);
      const center: [number, number] = [position.coords.longitude, position.coords.latitude];
      const target = {
        center,
        zoom: this.zoom,
      };
      if (isGoToProvider(this.view)) {
        await this.view.goTo(target);
      } else {
        setViewCenterZoom(this.view, target);
      }
      this.eventBus.emit(
        "locate.success",
        {
          position,
          center,
          zoom: this.zoom,
        },
        this,
      );
      return position;
    } catch (error) {
      this.eventBus.emit("locate.error", { error }, this);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// CompassCompat
// ---------------------------------------------------------------------------

export interface CompassCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
}

export class CompassCompat extends BaseControlCompat {
  public orientation: number;

  protected override get controlName(): string {
    return "compass";
  }

  public constructor(options: CompassCompatOptions = {}) {
    super(options);
    this.orientation = extractViewRotation(options.view) ?? 0;
  }

  public rotateTo(rotation: number): number {
    const next = Number.isFinite(rotation) ? rotation : this.orientation;
    this.orientation = next;
    this.notifyWatchers("orientation", this.orientation);
    if (isRecord(this.view)) {
      this.view.rotation = next;
    }
    this.eventBus.emit("compass.rotated", { rotation: next }, this);
    return this.orientation;
  }

  public reset(): number {
    const rotation = this.rotateTo(0);
    this.eventBus.emit("compass.reset", { rotation }, this);
    return rotation;
  }

  public goToNorth(): number {
    return this.reset();
  }
}

// ---------------------------------------------------------------------------
// ZoomCompat
// ---------------------------------------------------------------------------

export interface ZoomCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
  layout?: "vertical" | "horizontal";
}

export class ZoomCompat extends BaseControlCompat {
  public readonly layout: "vertical" | "horizontal";

  protected override get controlName(): string {
    return "zoom";
  }

  public constructor(options: ZoomCompatOptions = {}) {
    super(options);
    this.layout = options.layout ?? "vertical";
  }

  public zoomIn(step = 1): number | undefined {
    return this.adjustZoom(Math.abs(step));
  }

  public zoomOut(step = 1): number | undefined {
    return this.adjustZoom(-Math.abs(step));
  }

  private adjustZoom(delta: number): number | undefined {
    if (!isRecord(this.view) || typeof this.view.zoom !== "number" || !Number.isFinite(this.view.zoom)) {
      return undefined;
    }

    const next = this.view.zoom + delta;
    this.view.zoom = next;
    this.notifyWatchers("zoom", next);
    this.eventBus.emit("zoom.changed", { zoom: next, delta }, this);
    return next;
  }
}

// ---------------------------------------------------------------------------
// FullscreenCompat
// ---------------------------------------------------------------------------

export interface FullscreenCompatOptions {
  view?: unknown;
  container?: HTMLElement | string | null;
  element?: HTMLElement | null;
  eventBus?: CompatEventBus;
}

export class FullscreenCompat extends BaseControlCompat {
  public readonly element: HTMLElement | null;
  public active: boolean;

  protected override get controlName(): string {
    return "fullscreen";
  }

  public constructor(options: FullscreenCompatOptions = {}) {
    super(options);
    this.element = options.element ?? null;
    this.active = false;
  }

  public enter(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.notifyWatchers("active", this.active);
    this.eventBus.emit("fullscreen.changed", { active: true }, this);
  }

  public exit(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.notifyWatchers("active", this.active);
    this.eventBus.emit("fullscreen.changed", { active: false }, this);
  }

  public toggle(force?: boolean): boolean {
    const next = force ?? !this.active;
    if (next) {
      this.enter();
    } else {
      this.exit();
    }
    return this.active;
  }
}

// ---------------------------------------------------------------------------
// AttributionCompat
// ---------------------------------------------------------------------------

export interface AttributionCompatOptions {
  view?: unknown;
  map?: unknown;
  container?: HTMLElement | string | null;
  eventBus?: CompatEventBus;
  itemDelimiter?: string;
  attributions?: readonly string[];
}

export class AttributionCompat extends BaseControlCompat {
  public readonly map: unknown;
  public itemDelimiter: string;
  public attributions: string[];

  protected override get controlName(): string {
    return "attribution";
  }

  public constructor(options: AttributionCompatOptions = {}) {
    super({ view: options.view, container: options.container, eventBus: options.eventBus }, options.map);
    this.map = options.map ?? extractViewMap(options.view);
    this.itemDelimiter = options.itemDelimiter ?? " | ";
    this.attributions = options.attributions ? [...options.attributions] : [];
  }

  public addAttribution(value: string): void {
    if (value.trim().length === 0) {
      return;
    }
    this.attributions.push(value);
    this.notifyWatchers("attributions", this.attributions);
    this.notifyWatchers("text", this.getText());
    this.eventBus.emit("attribution.updated", { count: this.attributions.length }, this);
  }

  public removeAttribution(value: string): boolean {
    const index = this.attributions.indexOf(value);
    if (index < 0) {
      return false;
    }
    this.attributions.splice(index, 1);
    this.notifyWatchers("attributions", this.attributions);
    this.notifyWatchers("text", this.getText());
    this.eventBus.emit("attribution.updated", { count: this.attributions.length }, this);
    return true;
  }

  public getText(): string {
    if (this.attributions.length === 0) {
      return "";
    }
    return this.attributions.join(this.itemDelimiter);
  }
}

// ---------------------------------------------------------------------------
// Private helper functions
// ---------------------------------------------------------------------------

interface GoToProvider {
  goTo(target: { center?: unknown; zoom?: number }): Promise<unknown> | unknown;
}

interface MapBasemapSetter {
  setBasemap(basemap: unknown): void;
}

function isGoToProvider(value: unknown): value is GoToProvider {
  return isRecord(value) && typeof value.goTo === "function";
}

function setViewCenterZoom(view: unknown, target: { center?: unknown; zoom?: number }): void {
  if (!isRecord(view)) {
    return;
  }
  if (target.center !== undefined) {
    view.center = target.center;
  }
  if (typeof target.zoom === "number") {
    view.zoom = target.zoom;
  }
}

function extractViewCenter(view: unknown): unknown {
  if (!isRecord(view)) {
    return undefined;
  }
  return view.center;
}

function extractViewZoom(view: unknown): number | undefined {
  if (!isRecord(view) || typeof view.zoom !== "number" || !Number.isFinite(view.zoom)) {
    return undefined;
  }
  return view.zoom;
}

function extractViewMap(view: unknown): unknown {
  if (!isRecord(view)) {
    return undefined;
  }
  return view.map;
}

function extractMapBasemap(map: unknown): unknown {
  if (!isRecord(map)) {
    return undefined;
  }
  return map.basemap;
}

function extractPayloadBasemap(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload.basemap;
}

function setMapBasemap(map: unknown, basemap: unknown, eventBus: CompatEventBus, source: unknown): void {
  if (!isRecord(map)) {
    return;
  }
  if (isMapBasemapSetter(map)) {
    map.setBasemap(basemap);
    return;
  }

  map.basemap = basemap;
  eventBus.emit("map.basemap-changed", { basemap }, source);
}

function isMapBasemapSetter(value: unknown): value is MapBasemapSetter {
  return isRecord(value) && typeof value.setBasemap === "function";
}

function buildScaleBarText(scale: number, unit: ScaleBarUnitCompat): string {
  const ratioText = `1:${Math.max(1, Math.round(scale)).toLocaleString("en-US")}`;
  if (unit === "metric") {
    return `${ratioText} | ${formatMetricDistance(scale)}`;
  }
  if (unit === "imperial") {
    return `${ratioText} | ${formatImperialDistance(scale)}`;
  }
  return `${ratioText} | ${formatMetricDistance(scale)} / ${formatImperialDistance(scale)}`;
}

function formatMetricDistance(scale: number): string {
  const meters = Math.max(1, Math.round(scale * 0.00028));
  if (meters >= 1000) {
    return `${Math.round(meters / 1000)} km`;
  }
  return `${meters} m`;
}

function formatImperialDistance(scale: number): string {
  const feet = Math.max(1, Math.round(scale * 0.0009186351706));
  if (feet >= 5280) {
    return `${Math.round(feet / 5280)} mi`;
  }
  return `${feet} ft`;
}

function getDefaultLocateProvider(): () => Promise<LocatePositionCompat> {
  return () =>
    new Promise<LocatePositionCompat>((resolve, reject) => {
      const geolocation = globalThis.navigator?.geolocation;
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
        reject(new Error("Geolocation API is unavailable; provide locateProvider."));
        return;
      }

      geolocation.getCurrentPosition(
        (position) => {
          resolve({
            coords: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
            },
          });
        },
        (error) => {
          reject(error);
        },
      );
    });
}

function extractViewRotation(view: unknown): number | undefined {
  if (!isRecord(view)) {
    return undefined;
  }
  const rotation = view.rotation;
  return typeof rotation === "number" && Number.isFinite(rotation) ? rotation : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
