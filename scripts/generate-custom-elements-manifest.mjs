#!/usr/bin/env node
/**
 * Generates `config/custom-elements.json`, a Custom Elements Manifest
 * (schemaVersion 1.0.0) for the web components `@honua/app-platform` ships
 * (issue #1419; the format honua-server#3246 consumes).
 *
 * The manifest is derived from source, never hand-maintained:
 *
 * - tag names come from the `registry.define("<tag>", <Class>)` calls;
 * - public fields and methods come from the class's public accessors and
 *   methods, with types resolved through the TypeScript checker so a
 *   string-literal union alias (`HonuaMeasureDistanceUnit`) is published as
 *   its literal members — what an agent or binding generator needs;
 * - attributes come from `static observedAttributes`, paired with the field
 *   they drive by camel-casing;
 * - events, CSS parts, and attributes without a backing field are documented
 *   with `@fires` / `@csspart` / `@attr` class tags, and generation FAILS when a
 *   dispatched event, a rendered `part`, or an observed attribute has no tag,
 *   so the documentation cannot silently fall behind the element;
 * - CSS custom properties come from the `:host` declarations with defaults.
 *
 * Usage: `node scripts/generate-custom-elements-manifest.mjs write|check`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MANIFEST_PATH = "config/custom-elements.json";

/**
 * Source modules whose custom elements the manifest covers, mapped to their
 * path inside the published `@honua/app-platform` package. Add a module here to
 * publish its elements; generation enforces the tag discipline above for it.
 */
export const CUSTOM_ELEMENT_MODULES = [
  { source: "src/web-components/measurement.ts", packagePath: "web-components/measurement.js" },
];

const SOURCE_BASE_URL = "https://github.com/honua-io/honua-sdk-js/blob/trunk/";
const LIFECYCLE_CALLBACKS = new Set([
  "connectedCallback",
  "disconnectedCallback",
  "attributeChangedCallback",
  "adoptedCallback",
]);

export function buildManifest(repositoryRoot = root) {
  const files = CUSTOM_ELEMENT_MODULES.map((entry) => path.join(repositoryRoot, entry.source));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const checker = program.getTypeChecker();
  return {
    schemaVersion: "1.0.0",
    readme: "",
    modules: CUSTOM_ELEMENT_MODULES.map((entry) => {
      const sourceFile = program.getSourceFile(path.join(repositoryRoot, entry.source));
      if (!sourceFile) throw new Error(`cannot load ${entry.source}`);
      return analyzeModule(sourceFile, entry, checker);
    }),
  };
}

function analyzeModule(sourceFile, entry, checker) {
  localAliases = moduleLocalAliases(sourceFile);
  const tags = definedTags(sourceFile);
  if (tags.size === 0) throw new Error(`${entry.source} defines no custom element`);
  const declarations = [];
  const exports = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const className = statement.name.text;
    const tagName = tags.get(className);
    if (!tagName) continue;
    declarations.push(analyzeClass(sourceFile, statement, tagName, entry, checker));
    exports.push(
      { kind: "js", name: className, declaration: { name: className, module: entry.packagePath } },
      { kind: "custom-element-definition", name: tagName, declaration: { name: className, module: entry.packagePath } },
    );
  }
  return { kind: "javascript-module", path: entry.packagePath, declarations, exports };
}

function definedTags(sourceFile) {
  const tags = new Map();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "define" &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ts.isIdentifier(node.arguments[1])
    ) {
      tags.set(node.arguments[1].text, node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return tags;
}

function analyzeClass(sourceFile, node, tagName, entry, checker) {
  const classTags = jsDocTags(node);
  const members = [];
  const accessors = new Map();
  for (const member of node.members) {
    if (!member.name || ts.isPrivateIdentifier(member.name) || !ts.isIdentifier(member.name)) continue;
    const name = member.name.text;
    if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
    if (LIFECYCLE_CALLBACKS.has(name)) continue;
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      const pair = accessors.get(name) ?? {};
      if (ts.isGetAccessorDeclaration(member)) pair.get = member;
      else pair.set = member;
      accessors.set(name, pair);
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      members.push(
        compact({
          kind: "method",
          name,
          privacy: "public",
          description: jsDocDescription(member),
          parameters: member.parameters.map((parameter) =>
            compact({
              name: parameter.name.getText(sourceFile),
              optional: parameter.questionToken || parameter.initializer ? true : undefined,
              type: { text: typeText(checker.getTypeAtLocation(parameter), checker, parameter) },
            }),
          ),
          return: signature ? { type: { text: typeText(signature.getReturnType(), checker, member) } } : undefined,
        }),
      );
    }
  }
  for (const [name, pair] of accessors) {
    const source = pair.get ?? pair.set;
    const type = pair.get
      ? checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(pair.get))
      : checker.getTypeAtLocation(pair.set.parameters[0]);
    members.push(
      compact({
        kind: "field",
        name,
        privacy: "public",
        readonly: pair.set ? undefined : true,
        description: jsDocDescription(pair.get) || (pair.set ? jsDocDescription(pair.set) : "") || jsDocDescription(source),
        type: { text: typeText(type, checker, source) },
      }),
    );
  }
  members.sort((left, right) => left.name.localeCompare(right.name));

  const fieldsByName = new Map(members.filter((member) => member.kind === "field").map((member) => [member.name, member]));
  const attrTags = new Map(classTags.filter((tag) => tag.tag === "attr").map((tag) => [tag.name, tag]));
  const attributes = observedAttributes(sourceFile, node).map((attributeName) => {
    const fieldName = attributeName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const field = fieldsByName.get(fieldName);
    const tag = attrTags.get(attributeName);
    if (!field && !tag) {
      throw new Error(`${tagName}: observed attribute "${attributeName}" has neither a field nor an @attr tag`);
    }
    return compact({
      name: attributeName,
      fieldName: field ? fieldName : undefined,
      description: tag?.description || field?.description,
      type: tag?.type ? { text: tag.type } : field ? { text: field.type.text.replace(/ \| undefined$/, "") } : undefined,
    });
  });
  for (const name of attrTags.keys()) {
    if (!attributes.some((attribute) => attribute.name === name)) {
      throw new Error(`${tagName}: @attr ${name} is not an observed attribute`);
    }
  }

  const events = classTags.filter((tag) => tag.tag === "fires").map((tag) =>
    compact({ name: tag.name, description: tag.description, type: tag.type ? { text: tag.type } : undefined }),
  );
  for (const dispatched of dispatchedEventNames(sourceFile, node)) {
    if (!events.some((event) => event.name === dispatched)) {
      throw new Error(`${tagName}: dispatches "${dispatched}" without an @fires tag`);
    }
  }
  const text = sourceFile.getFullText();
  const cssParts = classTags
    .filter((tag) => tag.tag === "csspart")
    .map((tag) => compact({ name: tag.name, description: tag.description }));
  for (const match of text.matchAll(/part="([a-z-]+)"/g)) {
    if (!cssParts.some((part) => part.name === match[1])) {
      throw new Error(`${tagName}: renders part="${match[1]}" without an @csspart tag`);
    }
  }
  const hostBlock = /:host\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const cssProperties = [...hostBlock.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => ({
    name: match[1],
    default: match[2].trim(),
  }));

  return compact({
    kind: "class",
    customElement: true,
    tagName,
    name: node.name.text,
    description: jsDocDescription(node),
    superclass: { name: "HTMLElement", package: "global:" },
    members,
    attributes,
    events,
    cssParts,
    cssProperties,
    source: { href: `${SOURCE_BASE_URL}${entry.source}` },
  });
}

function observedAttributes(sourceFile, node) {
  const getter = node.members.find(
    (member) =>
      ts.isGetAccessorDeclaration(member) &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      member.name.getText(sourceFile) === "observedAttributes",
  );
  if (!getter?.body) return [];
  const returned = getter.body.statements.find(ts.isReturnStatement)?.expression;
  if (!returned || !ts.isArrayLiteralExpression(returned)) {
    throw new Error("observedAttributes must return an array literal");
  }
  const names = [];
  for (const element of returned.elements) {
    if (ts.isStringLiteral(element)) names.push(element.text);
    else if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      names.push(...constStringArray(sourceFile, element.expression.text));
    } else {
      throw new Error(`unsupported observedAttributes element: ${element.getText(sourceFile)}`);
    }
  }
  return names;
}

function constStringArray(sourceFile, identifier) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== identifier || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
      if (ts.isArrayLiteralExpression(initializer)) {
        return initializer.elements.map((element) => {
          if (!ts.isStringLiteral(element)) throw new Error(`${identifier} must hold string literals`);
          return element.text;
        });
      }
    }
  }
  throw new Error(`cannot resolve observed attribute list ${identifier}`);
}

function dispatchedEventNames(sourceFile, node) {
  const names = new Set();
  const visit = (child) => {
    if (
      ts.isNewExpression(child) &&
      /CustomEvent$/.test(child.expression.getText(sourceFile)) &&
      child.arguments?.[0] &&
      ts.isStringLiteral(child.arguments[0])
    ) {
      names.add(child.arguments[0].text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** Non-exported type aliases of the module being analyzed; consumers cannot name them. */
let localAliases = new Map();

function moduleLocalAliases(sourceFile) {
  const aliases = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      aliases.set(statement.name.text, statement.type.getText(sourceFile));
    }
  }
  return aliases;
}

function typeText(type, checker, enclosing) {
  const text = rawTypeText(type, checker, enclosing);
  return text.replace(/\b([A-Za-z_$][\w$]*)\b(\[\])?/g, (match, name, arraySuffix = "") => {
    const expansion = localAliases.get(name);
    if (!expansion) return match;
    return arraySuffix && /\s/.test(expansion) ? `(${expansion})[]` : `${expansion}${arraySuffix}`;
  });
}

function rawTypeText(type, checker, enclosing) {
  if (type.isUnion()) {
    const flags = type.types.map((member) => member.flags);
    if (type.types.length === 2 && flags.every((flag) => flag & ts.TypeFlags.BooleanLiteral)) return "boolean";
    const booleanParts = type.types.filter((member) => member.flags & ts.TypeFlags.BooleanLiteral);
    const parts = type.types
      .filter((member) => booleanParts.length !== 2 || !(member.flags & ts.TypeFlags.BooleanLiteral))
      .map((member) => rawTypeText(member, checker, enclosing));
    if (booleanParts.length === 2) parts.push("boolean");
    // Keep literal members in declaration order and put undefined last.
    const defined = parts.filter((part) => part !== "undefined");
    return [...new Set(defined), ...(parts.includes("undefined") ? ["undefined"] : [])].join(" | ");
  }
  if (type.isStringLiteral()) return JSON.stringify(type.value);
  return checker.typeToString(type, enclosing, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
}

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function jsDocDescription(node) {
  if (!node) return "";
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const comment = docs.at(-1)?.comment;
  return normalizeDoc(typeof comment === "string" ? comment : ts.getTextOfJSDocComment(comment) ?? "");
}

/** Parses `@attr {type} name - description`, `@fires {type} name - description`, `@csspart name - description`. */
function jsDocTags(node) {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const parsed = [];
  for (const tag of docs.at(-1)?.tags ?? []) {
    const tagName = tag.tagName.text;
    if (!["attr", "fires", "csspart"].includes(tagName)) continue;
    const raw = normalizeDoc(typeof tag.comment === "string" ? tag.comment : ts.getTextOfJSDocComment(tag.comment) ?? "");
    const match = /^(?:\{(.+?)\}\s+)?([a-z][a-z0-9-]*)\s+-\s+(.+)$/s.exec(raw);
    if (!match) throw new Error(`malformed @${tagName} tag: ${raw}`);
    parsed.push({ tag: tagName, type: match[1], name: match[2], description: match[3] });
  }
  return parsed;
}

function normalizeDoc(text) {
  return text
    .replace(/\{@link\s+([^}\s|]+)(?:\s*\|\s*[^}]*)?\}/g, "`$1`")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== "" && !(Array.isArray(entry) && entry.length === 0),
    ),
  );
}

export function renderManifest(repositoryRoot = root) {
  return `${JSON.stringify(buildManifest(repositoryRoot), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const target = path.join(root, MANIFEST_PATH);
  const rendered = renderManifest();
  if (mode === "write") {
    fs.writeFileSync(target, rendered, "utf8");
    process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
  } else if (mode === "check") {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (current !== rendered) {
      process.stderr.write(`${MANIFEST_PATH} is stale; run npm run custom-elements:manifest\n`);
      process.exit(1);
    }
    process.stdout.write(`${MANIFEST_PATH} is current\n`);
  } else {
    throw new Error("usage: generate-custom-elements-manifest.mjs write|check");
  }
}
