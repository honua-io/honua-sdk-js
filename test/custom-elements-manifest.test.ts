// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CustomElementsManifest,
  CustomElementsManifestDeclaration,
} from "../scripts/generate-custom-elements-manifest.mjs";
import {
  CUSTOM_ELEMENT_MODULES,
  MANIFEST_PATH,
  renderManifest,
} from "../scripts/generate-custom-elements-manifest.mjs";
import { defineHonuaWebComponents } from "../src/web-components/index.js";

/**
 * Custom Elements Manifest evidence (issue #1419 AC-3).
 *
 * The committed manifest must equal a fresh generation from source, and —
 * because a manifest that merely agrees with itself proves nothing — every
 * claim it makes is checked against the registered runtime element: tag,
 * observed attributes, attribute-to-property wiring for every literal the
 * manifest advertises, field writability, methods, rendered CSS parts, the
 * `:host` custom properties, and the events it says the element fires.
 */

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), MANIFEST_PATH), "utf8")) as CustomElementsManifest;

function literalMembers(typeText: string | undefined): string[] {
  return [...(typeText ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

const declarations: CustomElementsManifestDeclaration[] = manifest.modules.flatMap((module) => [
  ...module.declarations,
]);

describe("custom elements manifest", () => {
  it("is current with the element source", () => {
    expect(fs.readFileSync(path.join(process.cwd(), MANIFEST_PATH), "utf8")).toBe(renderManifest());
  }, 60_000);

  it("covers every configured module and publishes each tag once", () => {
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.modules.map((module) => module.path)).toEqual(
      CUSTOM_ELEMENT_MODULES.map((entry) => entry.packagePath),
    );
    const tags = declarations.map((declaration) => declaration.tagName);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("honua-measurement");
  });

  for (const declaration of declarations) {
    describe(`<${declaration.tagName}>`, () => {
      const element = (): HTMLElement & Record<string, unknown> => {
        defineHonuaWebComponents();
        const created = document.createElement(declaration.tagName) as HTMLElement & Record<string, unknown>;
        document.body.append(created);
        return created;
      };

      it("is registered under its tag by the class the manifest names", () => {
        defineHonuaWebComponents();
        const elementClass = customElements.get(declaration.tagName) as
          | (CustomElementConstructor & { name: string })
          | undefined;
        expect(elementClass?.name).toBe(declaration.name);
      });

      it("lists exactly the attributes the element observes", () => {
        defineHonuaWebComponents();
        const elementClass = customElements.get(declaration.tagName) as unknown as { observedAttributes: string[] };
        expect([...elementClass.observedAttributes].sort()).toEqual(
          declaration.attributes.map((attribute) => attribute.name).sort(),
        );
      });

      it("wires every field-backed attribute, for every advertised value, onto its property", () => {
        for (const attribute of declaration.attributes.filter((candidate) => candidate.fieldName)) {
          const fieldName = attribute.fieldName as string;
          const literals = literalMembers(attribute.type?.text);
          const target = element();
          if (literals.length > 0) {
            for (const literal of literals) {
              target.setAttribute(attribute.name, literal);
              expect(target[fieldName], `${attribute.name}="${literal}"`).toBe(literal);
            }
          } else if (attribute.type?.text === "number") {
            target.setAttribute(attribute.name, "4");
            expect(target[fieldName]).toBe(4);
          } else {
            throw new Error(`no runtime probe for ${attribute.name}: ${attribute.type?.text}`);
          }
          target.remove();
        }
      });

      it("matches field writability and method presence on the prototype", () => {
        defineHonuaWebComponents();
        const prototype = (customElements.get(declaration.tagName) as CustomElementConstructor).prototype;
        for (const member of declaration.members) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, member.name);
          expect(descriptor, member.name).toBeDefined();
          if (member.kind === "method") {
            expect(typeof descriptor?.value, member.name).toBe("function");
          } else {
            expect(typeof descriptor?.get, member.name).toBe("function");
            expect(typeof descriptor?.set, member.name).toBe(member.readonly ? "undefined" : "function");
          }
        }
      });

      it("renders every CSS part and declares every CSS custom property", () => {
        const target = element();
        // Some parts only render in an active state; activate a mode where the element supports one.
        (target.setMode as ((mode: string) => void) | undefined)?.call(target, "distance");
        const root = target.shadowRoot as ShadowRoot;
        for (const part of declaration.cssParts) {
          expect(root.querySelector(`[part~='${part.name}']`), part.name).not.toBeNull();
        }
        const styles = [...root.querySelectorAll("style")].map((style) => style.textContent).join("\n");
        for (const property of declaration.cssProperties) {
          expect(styles, property.name).toContain(`${property.name}: ${property.default};`);
        }
        target.remove();
      });

      it("fires the events it declares", () => {
        const target = element();
        const fired = new Set<string>();
        for (const event of declaration.events) target.addEventListener(event.name, () => fired.add(event.name));
        (target.setMode as ((mode: string) => void) | undefined)?.call(target, "area");
        expect([...fired].sort()).toEqual(declaration.events.map((event) => event.name).sort());
        target.remove();
      });
    });
  }
});
