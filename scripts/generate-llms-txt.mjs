#!/usr/bin/env node
// Deterministically generate `llms.txt` (curated index) and `llms-full.txt`
// (concatenated docs corpus) from README.md, docs/*.md, and key entrypoint
// JSDoc summaries.
//
// The output is a pure function of the repo's committed sources — no
// timestamps, no environment reads beyond an optional base-URL override — so
// `npm run verify:llms` can regenerate and git-diff for drift.
//
// Curate section ordering and one-line descriptions in the CONFIG block below,
// not by hand-editing the generated files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Base URL that documentation links resolve against. Defaults to stable GitHub
// blob URLs on the default branch so the index works for any agent that fetches
// it. honua-site can regenerate with LLMS_BASE_URL set to the docs domain.
const BASE_URL = (process.env.LLMS_BASE_URL ?? "https://github.com/honua-io/honua-sdk-js/blob/trunk").replace(
  /\/+$/,
  "",
);

const TITLE = "@honua/sdk-js";

const SUMMARY =
  "One TypeScript/JavaScript geospatial client for Esri GeoServices, OGC API " +
  "(Features/Tiles/Maps/Processes), STAC, WMS/WMTS, WFS 2.0, and OData v4 — a single " +
  "protocol-neutral Dataset → Source → Query → Result contract, a MapLibre-first map " +
  "runtime, and a drop-in ArcGIS migration codemod.";

const INTRO = [
  "Capability gaps throw `HonuaCapabilityNotSupportedError` rather than returning empty data.",
  "The same `Source.query(...)` call works across every supported protocol; the raw protocol",
  "shape stays reachable through the typed `Source.protocol(...)` escape hatch. Installing the",
  "SDK also installs the `honua` CLI, and a standalone `@honua/mcp-server` MCP server lives under",
  "`mcp/`. For agents: prefer the current APIs documented below over any recalled from training data.",
].join(" ");

// Documentation sections. `title` links resolve from each doc's own H1; the
// `description` is the curated one-line summary shown in the index.
const SECTIONS = [
  {
    title: "Getting started",
    entries: [
      { path: "README.md", description: "Project overview, install, 60-second quickstart, and the demo index." },
      { path: "INSTALL.md", description: "Install instructions and the subpath entrypoint / stability table." },
      {
        path: "docs/generated/sample-catalog.md",
        description:
          "Generated inventory of every executable SDK example, including support, data mode, lifecycle, and demonstration intent.",
      },
      { path: "docs/quickstart.md", description: "5-minute quickstart: query features and render them on a map." },
      {
        path: "docs/generated/learning-paths.md",
        description:
          "Task-oriented progression from first public map through connect, query, styling, analysis, editing, realtime/offline, 3D, migration, and safe automation.",
      },
      {
        path: "docs/standalone-quickstart.md",
        description:
          "Server-optional front door: run the SDK against any public GeoServices endpoint with no Honua server, key, or account.",
      },
      {
        path: "docs/quickstart-troubleshooting.md",
        description: "Common quickstart failure modes and how to fix them.",
      },
    ],
  },
  {
    title: "Core contract and API",
    entries: [
      {
        path: "docs/shared-client-contract.md",
        description: "Dataset / Source / Query / Result contract design and semantics.",
      },
      {
        path: "docs/query-planner.md",
        description:
          "Deterministic query IR and explain plans, GeoServices pushdown, and safe bounded-local execution policy.",
      },
      {
        path: "docs/decisions/north-star-sdk-application-kernel.md",
        description:
          "Accepted-for-review application-kernel boundary and API: connect, inspect, explain, query, mount, provenance, and safe agent plans.",
      },
      {
        path: "docs/protocol-capability-matrix.md",
        description: "Which operations each protocol supports and where capabilities fall back.",
      },
      {
        path: "docs/standalone-capability-matrix.md",
        description: "Backend-agnostic vs Honua-server-enhanced capabilities: what works with no server and what needs one.",
      },
      {
        path: "docs/sdk-surface-alignment.md",
        description: "Cross-language naming parity and the semver / stability policy.",
      },
      { path: "docs/errors.md", description: "Named error hierarchy, catch-narrowing, and retry policy." },
      {
        path: "docs/auth.md",
        description:
          "Authentication: pluggable auth providers, OAuth2 authorization-code + PKCE, token refresh, credential stores, and security guidance.",
      },
      {
        path: "docs/react.md",
        description: "@honua/react bindings: HonuaProvider, useQuery/useDataset hooks, and map components.",
      },
      {
        path: "docs/geometry.md",
        description:
          "@honua/geometry client-side ops (buffer/area/measure/simplify/reproject) and the geometryEngine compat shim coverage table.",
      },
      {
        path: "docs/bundle-sizes.md",
        description: "CI-enforced per-entrypoint bundle sizes (min + gzip) with budget policy.",
      },
      {
        path: "docs/guide.md",
        description: "Long-form reference: server compatibility, entrypoints, protocol cookbooks, auth bridge.",
      },
    ],
  },
  {
    title: "Protocols",
    entries: [
      { path: "docs/ogc-api.md", description: "OGC API Features / Tiles / Maps / Processes and STAC cookbooks." },
      { path: "docs/wfs.md", description: "WFS 2.0 adapter usage, filters, and exception handling." },
      {
        path: "docs/geoparquet.md",
        description:
          "GeoParquet / DuckDB-WASM Source: contract Query compiled to SQL over read_parquet, spatial pushdown, Overture recipe.",
      },
      {
        path: "docs/webmap-json-compatibility.md",
        description: "Parsing Esri WebMap JSON into Honua sources and MapLibre style.",
      },
    ],
  },
  {
    title: "Map runtime",
    entries: [
      {
        path: "docs/maplibre-runtime.md",
        description: "loadMapPackage() and HonuaMapRuntime — render a MapPackage on MapLibre GL JS.",
      },
      {
        path: "docs/pmtiles.md",
        description:
          "Native PMTiles support: auto-registered pmtiles:// protocol, lazy peer, describe() metadata, and a CDN recipe.",
      },
      { path: "docs/browser-bundle.md", description: "Build-less CDN / IIFE usage via the prebuilt browser bundle." },
      {
        path: "docs/studio-package-contracts.md",
        description: "Studio package-family projections, validation envelope, and capability manifest.",
      },
    ],
  },
  {
    title: "ArcGIS migration",
    entries: [
      {
        path: "docs/migration-honua-maplibre.md",
        description: "Migrating an ArcGIS Maps SDK app to the Honua MapLibre runtime.",
      },
      {
        path: "docs/migration-punch-list.md",
        description: "Codemod coverage, manual-intervention categories, and parity punch list.",
      },
      { path: "docs/esri-sample-corpus.md", description: "The Esri sample corpus used to certify migration coverage." },
    ],
  },
  {
    title: "MCP server",
    entries: [
      {
        path: "mcp/README.md",
        description: "@honua/mcp-server — MCP tools, resources, transports, and the certification harness.",
      },
    ],
  },
  {
    title: "AI assistants and skills",
    entries: [
      {
        path: "skills/README.md",
        description: "Agent skills for Claude Code / compatible agents and how to install them.",
      },
    ],
  },
];

// Key public entrypoints. The link description is the leading JSDoc summary of
// the source file when present, else the curated fallback.
const ENTRYPOINTS = [
  { path: "src/index.ts", label: "@honua/sdk-js", fallback: "Root barrel of the most commonly used symbols." },
  { path: "src/honua.ts", label: "@honua/sdk-js/honua", fallback: "Honua-first client entrypoint." },
  {
    path: "src/contract/index.ts",
    label: "@honua/sdk-js/contract",
    fallback: "Protocol-neutral Dataset / Source / Query / Result vocabulary.",
  },
  {
    path: "src/query-planner/index.ts",
    label: "@honua/sdk-js/query-planner",
    fallback: "Deterministic query IR, explain plans, and bounded execution.",
  },
  {
    path: "src/esri-compat-entry.ts",
    label: "@honua/sdk-js/esri-compat",
    fallback: "Esri ArcGIS JS-API compatibility wrappers (FeatureLayerCompat, MapViewCompat, ...).",
  },
  {
    path: "src/migration-entry.ts",
    label: "@honua/sdk-js/migration",
    fallback: "Codemod, scanner, and reporting used by the honua-migrate CLI.",
  },
  { path: "src/runtime/index.ts", label: "@honua/sdk-js/runtime", fallback: "MapLibre GL JS-first MapPackage runtime." },
  {
    path: "src/geocoding/index.ts",
    label: "@honua/sdk-js/geocoding",
    fallback: "HonuaGeocodingClient for forward / reverse geocoding and typeahead.",
  },
  {
    path: "src/expr/index.ts",
    label: "@honua/sdk-js/expr",
    fallback: "Typed expression builder compiling to MapLibre-style expressions.",
  },
  {
    path: "src/webmap/index.ts",
    label: "@honua/sdk-js/webmap",
    fallback: "WebMap JSON parse + symbol / renderer / popup converters.",
  },
  {
    path: "src/geoparquet/index.ts",
    label: "@honua/sdk-js/geoparquet",
    fallback: "GeoParquet / DuckDB-WASM Source: contract Query compiled to SQL over read_parquet.",
  },
];

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function extractH1(markdown, fallback) {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return stripInlineCode(match[1]);
  }
  return fallback;
}

// Strip surrounding backticks so a doc titled "# `@honua/sdk-js`" reads cleanly
// inside a Markdown link label (which cannot itself contain code spans nicely).
function stripInlineCode(text) {
  return text.replace(/`/g, "");
}

// Extract the first paragraph of a leading `/** ... */` block comment and
// reduce it to a single sentence for use as a one-line description.
function extractJsDocSummary(source) {
  const trimmed = source.replace(/^﻿/, "").trimStart();
  if (!trimmed.startsWith("/**")) return undefined;
  const end = trimmed.indexOf("*/");
  if (end === -1) return undefined;
  const body = trimmed.slice(3, end);
  const lines = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*\*\s?/, "").trimEnd();
    if (line.trim().startsWith("@")) break; // stop at the first JSDoc tag
    if (line.trim() === "") {
      if (lines.length > 0) break; // first paragraph only
      continue;
    }
    lines.push(line.trim());
  }
  if (lines.length === 0) return undefined;
  const paragraph = stripInlineCode(lines.join(" "));
  const sentenceEnd = paragraph.indexOf(". ");
  const sentence = sentenceEnd === -1 ? paragraph : paragraph.slice(0, sentenceEnd + 1);
  return sentence.replace(/\s+/g, " ").trim();
}

function linkFor(relPath) {
  return `${BASE_URL}/${relPath}`;
}

function buildIndex() {
  const out = [];
  out.push(`# ${TITLE}`);
  out.push("");
  out.push(`> ${SUMMARY}`);
  out.push("");
  out.push(INTRO);
  out.push("");

  for (const section of SECTIONS) {
    out.push(`## ${section.title}`);
    out.push("");
    for (const entry of section.entries) {
      const md = readFile(entry.path);
      const title = extractH1(md, path.basename(entry.path));
      out.push(`- [${title}](${linkFor(entry.path)}): ${entry.description}`);
    }
    out.push("");
  }

  out.push("## API entrypoints");
  out.push("");
  for (const entry of ENTRYPOINTS) {
    const source = readFile(entry.path);
    const summary = extractJsDocSummary(source) ?? entry.fallback;
    out.push(`- [${entry.label}](${linkFor(entry.path)}): ${summary}`);
  }
  out.push("");

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function buildFull() {
  // README first, then every referenced doc in section order (deduplicated).
  const corpus = ["README.md"];
  for (const section of SECTIONS) {
    for (const entry of section.entries) {
      if (!corpus.includes(entry.path)) corpus.push(entry.path);
    }
  }

  const out = [];
  out.push(`# ${TITLE} — full documentation corpus`);
  out.push("");
  out.push(`> ${SUMMARY}`);
  out.push("");
  out.push("This file concatenates the documents indexed in `llms.txt` for single-fetch ingestion.");
  out.push("");
  for (const relPath of corpus) {
    const md = readFile(relPath).replace(/\s+$/, "");
    out.push("---");
    out.push("");
    out.push(`# File: ${relPath}`);
    out.push("");
    out.push(md);
    out.push("");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const targets = [
    { file: "llms.txt", content: buildIndex() },
    { file: "llms-full.txt", content: buildFull() },
  ];

  let drift = false;
  for (const target of targets) {
    const absolute = path.join(ROOT, target.file);
    if (check) {
      const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
      if (existing !== target.content) {
        drift = true;
        process.stderr.write(`drift: ${target.file} is out of date; run \`npm run docs:llms\`\n`);
      }
    } else {
      fs.writeFileSync(absolute, target.content, "utf8");
      process.stdout.write(`wrote ${target.file} (${target.content.length} bytes)\n`);
    }
  }

  if (check && drift) process.exitCode = 1;
  else if (check) process.stdout.write("llms.txt / llms-full.txt are up to date\n");
}

main();
