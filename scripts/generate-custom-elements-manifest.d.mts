export const MANIFEST_PATH: string;

export const CUSTOM_ELEMENT_MODULES: ReadonlyArray<{ source: string; packagePath: string }>;

export interface CustomElementsManifestType {
  text: string;
}

export interface CustomElementsManifestMember {
  kind: "field" | "method";
  name: string;
  privacy: "public";
  readonly?: true;
  description?: string;
  type?: CustomElementsManifestType;
  parameters?: ReadonlyArray<{ name: string; optional?: true; type: CustomElementsManifestType }>;
  return?: { type: CustomElementsManifestType };
}

export interface CustomElementsManifestDeclaration {
  kind: "class";
  customElement: true;
  tagName: string;
  name: string;
  description?: string;
  superclass: { name: string; package: string };
  members: readonly CustomElementsManifestMember[];
  attributes: ReadonlyArray<{ name: string; fieldName?: string; description?: string; type?: CustomElementsManifestType }>;
  events: ReadonlyArray<{ name: string; description?: string; type?: CustomElementsManifestType }>;
  cssParts: ReadonlyArray<{ name: string; description?: string }>;
  cssProperties: ReadonlyArray<{ name: string; default: string }>;
  source: { href: string };
}

export interface CustomElementsManifest {
  schemaVersion: "1.0.0";
  readme: string;
  modules: ReadonlyArray<{
    kind: "javascript-module";
    path: string;
    declarations: readonly CustomElementsManifestDeclaration[];
    exports: ReadonlyArray<{ kind: "js" | "custom-element-definition"; name: string; declaration: { name: string; module: string } }>;
  }>;
}

export function buildManifest(repositoryRoot?: string): CustomElementsManifest;
export function renderManifest(repositoryRoot?: string): string;
