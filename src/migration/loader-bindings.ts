import ts from "typescript";

/**
 * Module-loader shapes that bind an ArcGIS module to a local name without an
 * ES `import` declaration.
 *
 * Two of them carry most of the real-world ArcGIS corpus:
 *
 * - **AMD dependency arrays** — `define([...], factory)` and
 *   `require([...], callback)`, the Dojo loader contract every ArcGIS JS 3.x
 *   app and every `dojoConfig`-driven 4.x app is written against. The module
 *   ids are positional: dependency *i* is delivered as factory parameter *i*.
 * - **TypeScript import-equals** — `import X = require("esri/WebMap")`, the
 *   form `@types/arcgis-js-api` documents for consuming AMD modules from
 *   TypeScript.
 *
 * The scanner and the codemod both need to recognize these, so the shape
 * knowledge lives here once instead of being restated in two walks.
 */

export interface AmdDependency {
  specifier: ts.StringLiteralLike;
  /** Factory parameter that receives this module, when the call declares one. */
  localName?: string;
}

/**
 * Dependencies of an AMD `define`/`require` call, or `undefined` when the call
 * is not one. Handles every argument arrangement in the wild:
 *
 * ```text
 * define([deps], factory)
 * define("id", [deps], factory)
 * require([deps], callback)
 * require([deps], callback, errback)
 * require(loaderConfig, [deps], callback)
 * ```
 */
export function readAmdDependencies(node: ts.CallExpression): AmdDependency[] | undefined {
  if (!ts.isIdentifier(node.expression)) {
    return undefined;
  }
  const callee = node.expression.text;
  if (callee !== "define" && callee !== "require") {
    return undefined;
  }

  const dependencyArrayIndex = findDependencyArrayIndex(node.arguments);
  if (dependencyArrayIndex < 0) {
    return undefined;
  }

  const dependencies = node.arguments[dependencyArrayIndex] as ts.ArrayLiteralExpression;
  const factory = findFactoryFunction(node.arguments, dependencyArrayIndex);
  const result: AmdDependency[] = [];
  dependencies.elements.forEach((element, index) => {
    if (!ts.isStringLiteralLike(element)) {
      return;
    }
    result.push({ specifier: element, localName: factoryParameterName(factory, index) });
  });
  return result;
}

export interface ImportEqualsBinding {
  modulePath: string;
  localName: string;
}

/** `import X = require("<spec>")`, or `undefined` for any other node. */
export function readImportEqualsBinding(node: ts.Node): ImportEqualsBinding | undefined {
  if (
    !ts.isImportEqualsDeclaration(node) ||
    !ts.isExternalModuleReference(node.moduleReference) ||
    !ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return undefined;
  }
  return { modulePath: node.moduleReference.expression.text, localName: node.name.text };
}

/**
 * The dependency array is the first argument in the plain form and the second
 * in the named-module (`define("id", [...], factory)`) and loader-config
 * (`require(dojoConfig, [...], callback)`) forms.
 */
function findDependencyArrayIndex(args: ts.NodeArray<ts.Expression>): number {
  const limit = Math.min(args.length, 2);
  for (let index = 0; index < limit; index += 1) {
    if (ts.isArrayLiteralExpression(args[index])) {
      return index;
    }
  }
  return -1;
}

function findFactoryFunction(
  args: ts.NodeArray<ts.Expression>,
  dependencyArrayIndex: number,
): ts.FunctionExpression | ts.ArrowFunction | undefined {
  for (let index = dependencyArrayIndex + 1; index < args.length; index += 1) {
    const candidate = args[index];
    if (ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function factoryParameterName(
  factory: ts.FunctionExpression | ts.ArrowFunction | undefined,
  index: number,
): string | undefined {
  const parameter = factory?.parameters[index];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return undefined;
  }
  return parameter.name.text;
}
