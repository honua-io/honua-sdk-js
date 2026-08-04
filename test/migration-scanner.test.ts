import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanArcGisUsage, summarizeArcGisScan } from "../src/migration/scanner.js";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "honua-arcgis-scan-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanArcGisUsage", () => {
  it("detects arcgis imports and symbol usage", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "map.ts"),
      [
        "import MapView from '@arcgis/core/views/MapView';",
        "import FeatureLayer from '@arcgis/core/layers/FeatureLayer';",
        "const view = new MapView({});",
        "const layer = new FeatureLayer({});",
        "void view; void layer;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.filesScanned).toBe(1);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.imports.length).toBe(2);
    expect(report.symbolUsageCounts.MapView).toBeGreaterThan(0);
    expect(report.symbolUsageCounts.FeatureLayer).toBeGreaterThan(0);
  });

  it("flags advanced migration risk patterns", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "app.ts"),
      [
        "import WebMap from '@arcgis/core/WebMap';",
        "const scene = import('@arcgis/core/views/SceneView');",
        "void scene; void WebMap;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports.some((item) => item.importClause === "import(...)")).toBe(true);
    expect(report.imports.some((item) => item.modulePath === "@arcgis/core/views/SceneView")).toBe(true);
    expect(report.flags).toContain("webmap-detected");
    expect(report.flags).toContain("dynamic-import-detected");
  });

  it("captures side-effect ArcGIS imports", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "side-effects.ts"),
      ["import '@arcgis/core/identity/IdentityManager';", "export const ready = true;"].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "side-effects.ts"),
        modulePath: "@arcgis/core/identity/IdentityManager",
        importClause: "side-effect-import",
        symbols: [],
      },
    ]);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.flags).toEqual(["auth-or-request-customization-detected"]);
  });

  it("captures require imports with local symbol usage", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "require-map.cjs"),
      [
        "const Map = require('@arcgis/core/Map').default;",
        "const map = new Map({ basemap: 'streets' });",
        "module.exports = { map };",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "require-map.cjs"),
        modulePath: "@arcgis/core/Map",
        importClause: "require(...)",
        symbols: ["Map"],
      },
    ]);
    expect(report.symbolUsageCounts.Map).toBeGreaterThan(0);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.flags).toEqual(["commonjs-detected"]);
  });

  it("captures destructured require default imports with local symbol usage", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "require-destructured.cjs"),
      [
        "const { default: MapCtor } = require('@arcgis/core/Map');",
        "const map = new MapCtor({ basemap: 'streets' });",
        "module.exports = { map };",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "require-destructured.cjs"),
        modulePath: "@arcgis/core/Map",
        importClause: "require(...)",
        symbols: ["MapCtor"],
      },
    ]);
    expect(report.symbolUsageCounts.MapCtor).toBeGreaterThan(0);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.flags).toEqual(["commonjs-detected"]);
  });

  it("captures arcgis re-export declarations", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "exports.ts"),
      [
        "export { default as FeatureLayer } from '@arcgis/core/layers/FeatureLayer';",
        "export * from '@arcgis/core/views/MapView';",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "exports.ts"),
        modulePath: "@arcgis/core/layers/FeatureLayer",
        importClause: "export { default as FeatureLayer }",
        symbols: ["FeatureLayer"],
      },
      {
        file: path.join(root, "exports.ts"),
        modulePath: "@arcgis/core/views/MapView",
        importClause: "export *",
        symbols: [],
      },
    ]);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.flags).toContain("arcgis-reexports-detected");
  });

  it("flags arcgis barrel module imports", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "barrel.ts"),
      [
        "import { FeatureLayer as ArcFeatureLayer, MapImageLayer } from '@arcgis/core/layers';",
        "import { MapView } from '@arcgis/core/views';",
        "void ArcFeatureLayer; void MapImageLayer; void MapView;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.flags).toContain("arcgis-barrel-imports-detected");
    expect(report.imports).toEqual([
      {
        file: path.join(root, "barrel.ts"),
        modulePath: "@arcgis/core/layers",
        importClause: "{ FeatureLayer as ArcFeatureLayer, MapImageLayer }",
        symbols: ["ArcFeatureLayer", "MapImageLayer"],
      },
      {
        file: path.join(root, "barrel.ts"),
        modulePath: "@arcgis/core/views",
        importClause: "{ MapView }",
        symbols: ["MapView"],
      },
    ]);
  });

  it("produces a stable summary string", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "index.ts"),
      "import FeatureLayer from '@arcgis/core/layers/FeatureLayer';\nvoid new FeatureLayer({});\n",
      "utf8",
    );

    const report = scanArcGisUsage(root);
    const summary = summarizeArcGisScan(report);

    expect(summary).toContain("filesScanned=1");
    expect(summary).toContain("filesWithArcGisImports=1");
    expect(summary).toContain("importCount=1");
    expect(summary).toContain("FeatureLayer");
  });

  it("flags auth/request customization patterns", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "auth.ts"),
      [
        "import esriConfig from '@arcgis/core/config';",
        "import IdentityManager from '@arcgis/core/identity/IdentityManager';",
        "esriConfig.request.interceptors.push({ before() {} });",
        "void IdentityManager;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.flags).toContain("auth-or-request-customization-detected");
  });

  it("flags unsupported advanced networking widget patterns", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "advanced.ts"),
      ["import Geoprocessor from '@arcgis/core/rest/geoprocessor/Geoprocessor';", "void Geoprocessor;"].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.flags).toContain("advanced-widget-or-networking-detected");
  });

  it("detects AMD dependency arrays with bare esri/* specifiers (#980)", () => {
    const root = makeTempProject();
    // Shapes taken from cmv/cmv-app @ 8b42b2336b1a4b357dda791c8e492b9612a5f51b:
    // viewer/js/config/viewer.js (define), viewer/js/config/app.js (require with
    // a loader config as the first argument).
    fs.writeFileSync(
      path.join(root, "viewer.js"),
      [
        "define([",
        "    'esri/units',",
        "    'esri/geometry/Extent',",
        "    'esri/config',",
        "    'esri/tasks/GeometryService',",
        "    'dojo/topic'",
        "], function (units, Extent, esriConfig, GeometryService, topic) {",
        "    var extent = new Extent();",
        "    void units; void esriConfig; void GeometryService; void topic; void extent;",
        "});",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "app.js"),
      [
        "require(window.dojoConfig, [",
        "    'dojo/_base/declare',",
        "    'esri/dijit/BasemapGallery'",
        "], function (declare, BasemapGallery) {",
        "    void declare; void BasemapGallery;",
        "});",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "named.js"),
      [
        "define('viewer/Widget', ['esri/layers/FeatureLayer'], function (FeatureLayer) {",
        "  void FeatureLayer;",
        "});",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.filesWithArcGisImports).toBe(3);
    expect(report.imports.every((item) => item.importClause === "amd-dependency-array")).toBe(true);
    expect(report.imports.map((item) => item.modulePath).sort()).toEqual([
      "esri/config",
      "esri/dijit/BasemapGallery",
      "esri/geometry/Extent",
      "esri/layers/FeatureLayer",
      "esri/tasks/GeometryService",
      "esri/units",
    ]);
    // Dependency ids are positional: the factory parameter that receives each
    // module is recorded as its local symbol.
    expect(report.imports.find((item) => item.modulePath === "esri/geometry/Extent")?.symbols).toEqual(["Extent"]);
    expect(report.imports.find((item) => item.modulePath === "esri/layers/FeatureLayer")?.symbols).toEqual([
      "FeatureLayer",
    ]);
    // Non-ArcGIS AMD dependencies are not claimed.
    expect(report.imports.some((item) => item.modulePath.startsWith("dojo/"))).toBe(false);
    expect(report.flags).toContain("amd-dependency-arrays-detected");
    expect(report.flags).toContain("arcgis-3x-dijit-detected");
    expect(report.symbolUsageCounts.Extent).toBeGreaterThan(0);
  });

  it("detects bare esri/* ES-module specifiers (#981)", () => {
    const root = makeTempProject();
    // Shape taken from WSDOT-GIS/bridge-clearance-app @ f07daaf455ac7c625c2d283c8d9df1e94665e4ea (src/main.ts).
    fs.writeFileSync(
      path.join(root, "main.ts"),
      [
        'import { AGSMouseEvent } from "esri";',
        'import esriConfig from "esri/config";',
        'import BasemapGallery from "esri/dijit/BasemapGallery";',
        'import FeatureLayer from "esri/layers/FeatureLayer";',
        'import EsriMap from "esri/map";',
        'import Query from "esri/tasks/query";',
        "const layer = new FeatureLayer({ url: serviceUrl });",
        "void AGSMouseEvent; void esriConfig; void BasemapGallery; void EsriMap; void Query; void layer;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.imports.map((item) => item.modulePath)).toEqual([
      "esri",
      "esri/config",
      "esri/dijit/BasemapGallery",
      "esri/layers/FeatureLayer",
      "esri/map",
      "esri/tasks/query",
    ]);
    expect(report.imports.find((item) => item.modulePath === "esri/layers/FeatureLayer")).toEqual({
      file: path.join(root, "main.ts"),
      modulePath: "esri/layers/FeatureLayer",
      importClause: "FeatureLayer",
      symbols: ["FeatureLayer"],
    });
    expect(report.symbolUsageCounts.FeatureLayer).toBeGreaterThan(0);
  });

  it("detects bare esri/* side-effect, re-export, require, and dynamic-import shapes (#981)", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "shapes.ts"),
      [
        "import 'esri/identity/IdentityManager';",
        "export { default as FeatureLayer } from 'esri/layers/FeatureLayer';",
        "const Map = require('esri/Map').default;",
        "const scene = import('esri/views/SceneView');",
        "void Map; void scene;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "shapes.ts"),
        modulePath: "esri/identity/IdentityManager",
        importClause: "side-effect-import",
        symbols: [],
      },
      {
        file: path.join(root, "shapes.ts"),
        modulePath: "esri/layers/FeatureLayer",
        importClause: "export { default as FeatureLayer }",
        symbols: ["FeatureLayer"],
      },
      {
        file: path.join(root, "shapes.ts"),
        modulePath: "esri/Map",
        importClause: "require(...)",
        symbols: ["Map"],
      },
      {
        file: path.join(root, "shapes.ts"),
        modulePath: "esri/views/SceneView",
        importClause: "import(...)",
        symbols: [],
      },
    ]);
    expect(report.flags).toContain("arcgis-reexports-detected");
    expect(report.flags).toContain("dynamic-import-detected");
    expect(report.flags).toContain("scene-3d-detected");
  });

  it("detects TypeScript import-equals modules (#981)", () => {
    const root = makeTempProject();
    // Shape taken from ekenes/national-park-visits @ 99b17289593454cc093648f7ba85b51f8ff25bad (app/main.ts).
    fs.writeFileSync(
      path.join(root, "main.ts"),
      [
        'import WebMap = require("esri/WebMap");',
        'import Legend = require("esri/widgets/Legend");',
        'import { whenFalseOnce } from "esri/core/watchUtils";',
        "const map = new WebMap({});",
        "void Legend; void whenFalseOnce; void map;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.filesWithArcGisImports).toBe(1);
    expect(report.imports).toEqual([
      {
        file: path.join(root, "main.ts"),
        modulePath: "esri/WebMap",
        importClause: "import-equals-require(...)",
        symbols: ["WebMap"],
      },
      {
        file: path.join(root, "main.ts"),
        modulePath: "esri/widgets/Legend",
        importClause: "import-equals-require(...)",
        symbols: ["Legend"],
      },
      {
        file: path.join(root, "main.ts"),
        modulePath: "esri/core/watchUtils",
        importClause: "{ whenFalseOnce }",
        symbols: ["whenFalseOnce"],
      },
    ]);
    expect(report.flags).toContain("typescript-import-equals-detected");
  });

  it("does not claim unrelated packages whose names start with esri", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "neighbors.ts"),
      [
        "import * as L from 'esri-leaflet';",
        "import { loadModules } from 'esri-loader';",
        "import local from './esri/helpers';",
        "void L; void loadModules; void local;",
      ].join("\n"),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([]);
    expect(report.filesWithArcGisImports).toBe(0);
    expect(report.esriLeafletImportCount).toBe(1);
  });

  it("detects esri-leaflet imports separately from arcgis imports", () => {
    const root = makeTempProject();
    fs.writeFileSync(
      path.join(root, "leaflet.ts"),
      ["import * as L from 'esri-leaflet';", "const layer = L.featureLayer({ url: serviceUrl });", "void layer;"].join(
        "\n",
      ),
      "utf8",
    );

    const report = scanArcGisUsage(root);
    expect(report.imports).toEqual([]);
    expect(report.filesWithArcGisImports).toBe(0);
    expect(report.esriLeafletImportCount).toBe(1);
    expect(report.filesWithEsriLeafletImports).toBe(1);
    expect(report.esriLeafletImports).toEqual([
      {
        file: path.join(root, "leaflet.ts"),
        modulePath: "esri-leaflet",
        importClause: "* as L",
        symbols: [],
      },
    ]);
    expect(report.flags).toContain("esri-leaflet-imports-detected");
  });
});
