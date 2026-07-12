import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `renderer` plugin. Turns an array of points into a deterministic
 * list of 2D draw commands. Pure and read-only, so it requests no grants.
 */
export interface ReferenceDrawCommand {
  readonly op: "point";
  readonly x: number;
  readonly y: number;
}

export interface ReferenceRendererExtension extends HonuaPluginExtension<"renderer"> {
  readonly draw: (points: readonly (readonly [number, number])[]) => readonly ReferenceDrawCommand[];
}

export const referenceRendererManifest = referenceManifest({
  id: "com.example.reference-renderer",
  kind: "renderer",
  packageName: "@example/reference-renderer",
  capabilities: ["2d"],
});

export function referenceRendererPlugin(
  events: string[] = [],
): HonuaPluginFactory<"renderer", ReferenceRendererExtension> {
  return {
    manifest: JSON.stringify(referenceRendererManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "renderer" as const,
          draw: (points: readonly (readonly [number, number])[]) =>
            points.map(([x, y]) => ({ op: "point" as const, x, y })),
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
