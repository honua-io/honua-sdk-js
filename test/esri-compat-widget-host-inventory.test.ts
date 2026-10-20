import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The migration guide's painting-host list is generated from the compat
 * call sites. A shim that never calls `new HonuaWidgetHost` or
 * `bindHonuaWidgetHost` stays in the state-only list.
 */

const root = path.resolve(import.meta.dirname, "..");
const compatDir = path.join(root, "src/esri-compat");
const guidePath = path.join(root, "docs/migration-honua-maplibre.md");

const HOST_CALL = /(?:new HonuaWidgetHost|bindHonuaWidgetHost|retargetWidgetHost)\(\s*"([^"]+)"/g;
const CLASS_EXPORT = /export class (\w+)/g;
const GUIDE_TAG = /`(honua-[a-z0-9-]+)`/g;
const GUIDE_CLASS = /`([A-Z][A-Za-z0-9]+)`/g;

function readCompat(file: string): string {
  return fs.readFileSync(path.join(compatDir, file), "utf8");
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

function section(markdown: string, name: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);
  expect(from, `${start} missing`).toBeGreaterThanOrEqual(0);
  expect(to, `${end} missing`).toBeGreaterThan(from);
  return markdown.slice(from + start.length, to);
}

function paintingTags(): string[] {
  const tags = new Set<string>();
  for (const file of fs.readdirSync(compatDir)) {
    if (!file.endsWith(".ts") || file === "widget-host.ts") continue;
    for (const tag of matches(readCompat(file), HOST_CALL)) tags.add(tag);
  }
  return [...tags].sort();
}

function stateOnlyClasses(): string[] {
  const names = new Set<string>();
  for (const file of fs.readdirSync(compatDir)) {
    // MapView's container is the map, not a widget host.
    if (!file.endsWith(".ts") || file === "widget-host.ts" || file === "map-view.ts") continue;
    const source = readCompat(file);
    if (!source.includes("container?:")) continue;
    if (matches(source, HOST_CALL).length > 0) continue;
    for (const name of matches(source, CLASS_EXPORT)) names.add(name);
  }
  return [...names].sort();
}

describe("compat widget host inventory", () => {
  const guide = fs.readFileSync(guidePath, "utf8");

  it("lists the same painting tags as the compat call sites", () => {
    const documented = [...new Set(matches(section(guide, "widget-host-tags"), GUIDE_TAG))].sort();
    expect(documented).toEqual(paintingTags());
  });

  it("describes shims that do not bind a host as state-only", () => {
    const body = section(guide, "widget-host-state-only");
    expect(body).toMatch(/state-model-only|state-only/);
    const documented = [...new Set(matches(body, GUIDE_CLASS))].sort();
    expect(documented).toEqual(stateOnlyClasses());
  });
});
