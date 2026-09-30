/**
 * Feature pager, attachments list, scale range, and route directions.
 * These render fixture data. They do not upload attachments, edit travel
 * modes, or invent route maneuvers.
 */

const HTMLElementBase: typeof HTMLElement =
  (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ?? (class {} as unknown as typeof HTMLElement);

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function section(element: HTMLElement, label: string, body: string): void {
  if (!element.shadowRoot) element.attachShadow({ mode: "open" });
  const shadow = element.shadowRoot;
  if (!shadow) return;
  shadow.innerHTML = `<section aria-label="${escapeText(label)}">${body}</section>`;
}

export class HonuaFeaturePagerElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #features: readonly { title?: string; attributes?: Record<string, unknown> }[] = [];
  #index = 0;

  public get features(): readonly { title?: string; attributes?: Record<string, unknown> }[] {
    return this.#features;
  }

  public set features(features: readonly { title?: string; attributes?: Record<string, unknown> }[] | undefined) {
    this.#features = features ?? [];
    this.#index = 0;
    this.render();
  }

  public get index(): number {
    return this.#index;
  }

  public connectedCallback(): void {
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  public next(): void {
    if (this.#features.length === 0) return;
    this.#index = (this.#index + 1) % this.#features.length;
    this.render();
  }

  private render(): void {
    const label = this.getAttribute("label") ?? "Features";
    const pages = this.#features
      .map((feature, index) => {
        const hidden = index === this.#index ? "" : " hidden";
        const title = feature.title ?? String(feature.attributes?.name ?? `Feature ${index + 1}`);
        return `<honua-feature-inspection data-page="${index}"${hidden}></honua-feature-inspection><p data-feature-title="${escapeText(title)}">${escapeText(title)}</p>`;
      })
      .join("");
    section(this, label, `<p>${this.#features.length === 0 ? "0" : this.#index + 1} / ${this.#features.length}</p>${pages}<button type="button" data-next>Next</button>`);
    this.#features.forEach((feature, index) => {
      const inspection = this.shadowRoot?.querySelector<HTMLElement & { selectedFeature?: unknown }>(
        `honua-feature-inspection[data-page="${index}"]`,
      );
      if (inspection) inspection.selectedFeature = feature;
    });
    this.shadowRoot?.querySelector("[data-next]")?.addEventListener("click", () => this.next());
  }
}

export class HonuaAttachmentsElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #names: readonly string[] = [];

  public get names(): readonly string[] {
    return this.#names;
  }

  public set names(names: readonly string[] | undefined) {
    this.#names = names ?? [];
    this.render();
  }

  public connectedCallback(): void {
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  private render(): void {
    const label = this.getAttribute("label") ?? "Attachments";
    const items = this.#names.map((name) => `<li>${escapeText(name)}</li>`).join("");
    section(this, label, `<ul>${items}</ul>`);
  }
}

export class HonuaScaleRangeElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #layer: { minScale?: number; maxScale?: number; setScaleRange?: (min: number, max: number) => void } | undefined;
  #min = 0;
  #max = 0;

  public get layer(): { minScale?: number; maxScale?: number; setScaleRange?: (min: number, max: number) => void } | undefined {
    return this.#layer;
  }

  public set layer(layer: { minScale?: number; maxScale?: number; setScaleRange?: (min: number, max: number) => void } | undefined) {
    this.#layer = layer;
    this.#min = layer?.minScale ?? 0;
    this.#max = layer?.maxScale ?? 0;
    this.render();
  }

  public connectedCallback(): void {
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  public setRange(minScale: number, maxScale: number): void {
    this.#min = minScale;
    this.#max = maxScale;
    if (this.#layer?.setScaleRange) this.#layer.setScaleRange(minScale, maxScale);
    else if (this.#layer) {
      this.#layer.minScale = minScale;
      this.#layer.maxScale = maxScale;
    }
    this.render();
  }

  private render(): void {
    const label = this.getAttribute("label") ?? "Scale range";
    section(
      this,
      label,
      `<label>Min <input data-min type="number" value="${this.#min}" /></label><label>Max <input data-max type="number" value="${this.#max}" /></label>`,
    );
    const commit = () => {
      const min = Number(this.shadowRoot?.querySelector<HTMLInputElement>("[data-min]")?.value);
      const max = Number(this.shadowRoot?.querySelector<HTMLInputElement>("[data-max]")?.value);
      if (Number.isFinite(min) && Number.isFinite(max)) this.setRange(min, max);
    };
    this.shadowRoot?.querySelector("[data-min]")?.addEventListener("change", commit);
    this.shadowRoot?.querySelector("[data-max]")?.addEventListener("change", commit);
  }
}

export interface DirectionsRouteLike {
  summary?: string;
  steps?: readonly { text?: string; maneuver?: string }[];
  polyline?: unknown;
}

export class HonuaDirectionsElement extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #route: DirectionsRouteLike | undefined;

  public get route(): DirectionsRouteLike | undefined {
    return this.#route;
  }

  public set route(route: DirectionsRouteLike | undefined) {
    this.#route = route;
    this.render();
  }

  public connectedCallback(): void {
    this.render();
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  private render(): void {
    const label = this.getAttribute("label") ?? "Directions";
    const steps = (this.#route?.steps ?? []).map((step) => step.text ?? step.maneuver).filter((text): text is string => Boolean(text));
    const summary = this.#route?.summary ?? "";
    const body =
      steps.length > 0
        ? `<p>${escapeText(summary)}</p><ol>${steps.map((step) => `<li>${escapeText(step)}</li>`).join("")}</ol>`
        : `<p>${escapeText(summary)}</p>`;
    section(this, label, body);
  }
}
