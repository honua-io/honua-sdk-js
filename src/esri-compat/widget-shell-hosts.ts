/**
 * Compat hosts for the feature pager, attachment list, and scale range.
 * They push shim state into the kit and do not build their own widget DOM.
 */

import type { CompatEventBus } from "./event-bus.js";
import { type HonuaWidgetHost, bindHonuaWidgetHost, pushWidgetHostState } from "./widget-host.js";

export class FeaturesCompat {
  public readonly view: unknown;
  public readonly container: unknown;
  public features: readonly unknown[];
  private widgetHost: HonuaWidgetHost | undefined;

  public constructor(
    options: {
      view?: unknown;
      container?: unknown;
      features?: readonly unknown[];
      eventBus?: CompatEventBus;
    } = {},
  ) {
    this.view = options.view;
    this.container = options.container;
    this.features = options.features ?? [];
    this.widgetHost = bindHonuaWidgetHost("honua-feature-pager", this.container, options.eventBus);
    this.push();
  }

  public setFeatures(features: readonly unknown[]): void {
    this.features = features;
    this.push();
  }

  private push(): void {
    pushWidgetHostState(this.widgetHost, { view: this.view, features: this.features });
  }
}

export function attachmentNamesFromQuery(response: {
  attachmentInfos?: readonly { name?: string }[];
  attachmentGroups?: readonly { attachmentInfos?: readonly { name?: string }[] }[];
}): string[] {
  const names: string[] = [];
  for (const info of response.attachmentInfos ?? []) {
    if (info.name) names.push(info.name);
  }
  for (const group of response.attachmentGroups ?? []) {
    for (const info of group.attachmentInfos ?? []) {
      if (info.name) names.push(info.name);
    }
  }
  return names;
}

export class AttachmentsCompat {
  public readonly container: unknown;
  public readonly layer:
    | { queryAttachments?: (options?: unknown) => Promise<Parameters<typeof attachmentNamesFromQuery>[0]> }
    | undefined;
  public names: readonly string[] = [];
  private widgetHost: HonuaWidgetHost | undefined;

  public constructor(
    options: {
      container?: unknown;
      layer?: AttachmentsCompat["layer"];
      names?: readonly string[];
      eventBus?: CompatEventBus;
    } = {},
  ) {
    this.container = options.container;
    this.layer = options.layer;
    this.names = options.names ?? [];
    this.widgetHost = bindHonuaWidgetHost("honua-attachments", this.container, options.eventBus);
    this.push();
  }

  public async load(): Promise<readonly string[]> {
    if (this.layer?.queryAttachments) {
      this.names = attachmentNamesFromQuery(await this.layer.queryAttachments());
    }
    this.push();
    return this.names;
  }

  private push(): void {
    pushWidgetHostState(this.widgetHost, { names: this.names });
  }
}

export class ScaleRangeCompat {
  public readonly container: unknown;
  public readonly layer:
    | { minScale?: number; maxScale?: number; setScaleRange?: (min: number, max: number) => void }
    | undefined;
  private widgetHost: HonuaWidgetHost | undefined;

  public constructor(
    options: {
      container?: unknown;
      layer?: ScaleRangeCompat["layer"];
      eventBus?: CompatEventBus;
    } = {},
  ) {
    this.container = options.container;
    this.layer = options.layer;
    this.widgetHost = bindHonuaWidgetHost("honua-scale-range", this.container, options.eventBus);
    this.push();
  }

  private push(): void {
    pushWidgetHostState(this.widgetHost, { layer: this.layer });
  }
}
