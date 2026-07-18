import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import type { FakeOlMap, FakeOpenLayersPeer } from "./fake-ol.js";
import { createFakeOpenLayersPeer } from "./fake-ol.js";
import { openLayersRendererManifest } from "./manifest.js";
import { type OpenLayersRendererKind, type OpenLayersRendererOptions, openLayersRenderer } from "./renderer-adapter.js";

import type { RendererAdapter } from "../../../../src/kernel/renderer.js";

/**
 * The `renderer` extension surface this plugin publishes: the mounted
 * `RendererAdapter` itself, so an application can pass it straight to
 * `connection.mount(target, { renderer: extension.adapter, rendererOptions })`
 * exactly like the built-in `maplibreRenderer`. Registering through
 * `HonuaPluginRegistry` never edits the SDK's built-in renderer union — this
 * extension carries its own namespaced `kind`.
 */
export interface OpenLayersRendererExtension extends HonuaPluginExtension<"renderer"> {
  readonly adapter: RendererAdapter<OpenLayersRendererKind, FakeOlMap, OpenLayersRendererOptions>;
  readonly peer: FakeOpenLayersPeer;
}

export function openLayersRendererPlugin(
  peer: FakeOpenLayersPeer = createFakeOpenLayersPeer(),
  events: string[] = [],
): HonuaPluginFactory<"renderer", OpenLayersRendererExtension> {
  return {
    manifest: JSON.stringify(openLayersRendererManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      const adapter = openLayersRenderer(peer);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "renderer" as const,
          adapter,
          peer,
        }),
        start() {
          events.push(`start:${context.manifest.id}`);
        },
        stop() {
          events.push(`stop:${context.manifest.id}`);
        },
        dispose() {
          events.push(`dispose:${context.manifest.id}`);
        },
      };
    },
  };
}
