#!/usr/bin/env node
// Assemble the static documentation site published to GitHub Pages
// (https://honua-io.github.io/honua-sdk-js/).
//
// Inputs (all committed sources, plus the TypeDoc build):
//   - README.md              -> landing page (index.html)
//   - INSTALL.md, docs/**.md -> guide corpus rendered to /guides/*.html with nav
//   - catalog-v2 site projection -> /gallery.html demo gallery
//   - dist/docs-api/**        -> TypeDoc API reference mounted at /api/
//
// The site is a pure function of the repo (no timestamps, no network) so the
// build is deterministic. Output goes to dist/docs-site (git-ignored via dist/).
//
// Internal cross-links between docs are rewritten to resolve inside the site;
// links to repo files we do not render (src/, examples/, mcp/, LICENSE, ...)
// fall back to stable GitHub blob URLs so every link still resolves.
//
// Usage: node scripts/build-docs-site.mjs   (run `npm run docs:api` first)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { currentDocsVersions, expandDocsVersionTokens, serializeDocsVersions } from "./docs-versions.mjs";
import {
  createGalleryModel,
  renderGalleryContent,
  verifyGalleryProjectionIntegrity,
} from "./lib/docs-gallery.mjs";
import { parseJsonDocument } from "./sample-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "docs-site");
const API_SRC = path.join(ROOT, "dist", "docs-api");
const SITE_PROJECTION_PATH = "samples/dist/honua-site-samples.v2.json";
const SITE_PROJECTION = path.join(ROOT, SITE_PROJECTION_PATH);
const SITE_CONSUMER_FIXTURE_PATH = "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json";
const SITE_CONSUMER_FIXTURE = path.join(ROOT, SITE_CONSUMER_FIXTURE_PATH);
// Playground links ride their own artifact rather than the site projection,
// whose schema is content-addressed by the committed consumer handoff (#958).
const SAMPLE_PLAYGROUNDS_PATH = "samples/dist/sample-playgrounds.v1.json";
const SAMPLE_PLAYGROUNDS = path.join(ROOT, SAMPLE_PLAYGROUNDS_PATH);

const SITE_TITLE = "@honua/sdk-js";
const SITE_URL = "https://honua-io.github.io/honua-sdk-js/";
const REPO = "honua-io/honua-sdk-js";
const BLOB_BASE = `https://github.com/${REPO}/blob/trunk`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/trunk`;
const DOC_VERSIONS = currentDocsVersions();
const SOURCE_REVISION = (process.env.HONUA_SOURCE_REVISION ||
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()).toLowerCase();
if (!/^[0-9a-f]{40}$/.test(SOURCE_REVISION)) throw new Error("Documentation source revision must be a full Git SHA");
const BUILT_DOC_VERSIONS = Object.freeze({
  ...DOC_VERSIONS,
  development: Object.freeze({ ...DOC_VERSIONS.development, sourceRevision: SOURCE_REVISION }),
});

if (DOC_VERSIONS.format !== "honua.sdk.docs-versions.v1") {
  throw new Error("documentation version manifest is invalid");
}

// ---------------------------------------------------------------------------
// Markdown -> HTML with link rewriting and heading anchors.
// ---------------------------------------------------------------------------

// The source markdown currently being rendered — consulted by the walkTokens
// hook to resolve relative links. Safe because marked.parse is synchronous.
let renderContext = null;

marked.use({
  gfm: true,
  breaks: false,
  walkTokens(token) {
    if (token.type === "link") {
      token.href = transformHref(token.href, renderContext, false);
    } else if (token.type === "image") {
      token.href = transformHref(token.href, renderContext, true);
    }
  },
});

function isExternal(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:)/i.test(href);
}

// Resolve a repo-relative markdown target to its path inside the built site, or
// null when the target is not rendered into the site.
function repoPathToSitePath(repoPath) {
  if (repoPath === "README.md") return "index.html";
  if (repoPath === "INSTALL.md") return "guides/INSTALL.html";
  if (repoPath.startsWith("docs/") && repoPath.endsWith(".md")) {
    return `guides/${repoPath.slice("docs/".length).replace(/\.md$/, ".html")}`;
  }
  return null;
}

function repoFileExists(repoPath) {
  return fs.existsSync(path.join(ROOT, repoPath)) && fs.statSync(path.join(ROOT, repoPath)).isFile();
}

// Resolve a link's repo-relative target. Some docs (notably docs/guide.md) author
// links as if the file lived at the repo root (`./docs/x.md`, `./examples/...`),
// while others use proper relative links (`./react.md`). Prefer whichever
// interpretation points at a file that actually exists.
function resolveTarget(rawPath, sourceDir) {
  const relTarget = path.posix.normalize(path.posix.join(sourceDir, rawPath));
  if (repoFileExists(relTarget)) return relTarget;
  const rootTarget = path.posix.normalize(rawPath.replace(/^(?:\.\.?\/)+/, ""));
  if (repoFileExists(rootTarget)) return rootTarget;
  return relTarget;
}

// Rewrite a markdown href so it resolves from the page currently being rendered.
function transformHref(href, ctx, isImage) {
  if (!href || isExternal(href)) return href;
  const [rawPath, frag] = splitFragment(href);
  if (rawPath === "") return href; // pure in-page anchor

  const sourceDir = path.posix.dirname(ctx.sourcePath);
  const target = resolveTarget(rawPath, sourceDir);

  const sitePath = repoPathToSitePath(target);
  if (sitePath) {
    const rel = relativeUrl(ctx.sitePath, sitePath);
    return frag ? `${rel}#${frag}` : rel;
  }
  // Not part of the rendered site: point at the repo so the link still works.
  // Images use the raw host so they display; everything else uses the blob view.
  const base = isImage ? RAW_BASE : BLOB_BASE;
  const url = `${base}/${target}`;
  return frag ? `${url}#${frag}` : url;
}

function splitFragment(href) {
  const i = href.indexOf("#");
  if (i === -1) return [href, ""];
  return [href.slice(0, i), href.slice(i + 1)];
}

// Relative URL from one site file to another (both site-root-relative paths).
function relativeUrl(fromSitePath, toSitePath) {
  const rel = path.posix.relative(path.posix.dirname(fromSitePath), toSitePath);
  return rel === "" ? path.posix.basename(toSitePath) : rel;
}

// Match GitHub's heading-anchor slug algorithm so author-written `#anchor`
// links resolve: lowercase, drop punctuation (keeping spaces/hyphens), then map
// each space to a hyphen WITHOUT collapsing runs (so "a + b" -> "a--b").
function slugify(text) {
  // Strip tags to a fixed point: a single-pass replace can leave fragments
  // that recombine into a tag (e.g. "<scr<b>ipt>"), which CodeQL flags as
  // js/incomplete-multi-character-sanitization. The character allowlist
  // below removes residual "<"/">" anyway; the loop makes it airtight.
  let stripped = text;
  for (let prev = ""; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, "");
  }
  return stripped
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

// Give every heading a stable id so in-page anchor links resolve.
function injectHeadingIds(html) {
  const seen = new Map();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    let id = slugify(inner) || "section";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

function renderMarkdown(md, ctx) {
  renderContext = ctx;
  try {
    return injectHeadingIds(marked.parse(expandDocsVersionTokens(md, DOC_VERSIONS)));
  } finally {
    renderContext = null;
  }
}

function extractH1(md, fallback) {
  for (const line of md.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/`/g, "");
  }
  return fallback;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Guide corpus discovery + navigation.
// ---------------------------------------------------------------------------

function walkMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

// Curated ordering for the sidebar. Anything not listed is appended under
// "More guides" grouped by its directory.
const NAV_GROUPS = [
  {
    title: "Getting started",
    docs: [
      "INSTALL.md",
      "docs/quickstart.md",
      "docs/quickstart-troubleshooting.md",
      "docs/comparison.md",
      "docs/documentation-versions.md",
      "docs/guide.md",
    ],
  },
  {
    title: "Core contract & API",
    docs: [
      "docs/shared-client-contract.md",
      "docs/protocol-capability-matrix.md",
      "docs/sdk-surface-alignment.md",
      "docs/errors.md",
      "docs/react.md",
      "docs/geometry.md",
      "docs/bundle-sizes.md",
    ],
  },
  { title: "Protocols", docs: ["docs/ogc-api.md", "docs/wfs.md", "docs/webmap-json-compatibility.md"] },
  {
    title: "Map runtime",
    docs: [
      "docs/maplibre-runtime.md",
      "docs/browser-bundle.md",
      "docs/studio-package-contracts.md",
      "docs/runtime-parity-showcase.md",
      "docs/scene-workspace.md",
    ],
  },
  {
    title: "AI agents & MCP",
    docs: [
      "docs/coding-agent-evals.md",
      "docs/generated/coding-agent-scorecard.md",
      "docs/generated/mcp-eval-scorecard.md",
      "docs/nl-map-control.md",
    ],
  },
  {
    title: "ArcGIS migration",
    docs: [
      "docs/migration-honua-maplibre.md",
      "docs/migration-punch-list.md",
      "docs/esri-sample-corpus.md",
      "docs/oss-arcgis-corpus.md",
      "docs/oss-arcgis-corpus-readiness.md",
      "docs/oss-arcgis-corpus-post-codemod-build.md",
    ],
  },
];

function buildNav(allDocs, titles) {
  const placed = new Set();
  const groups = [];
  for (const group of NAV_GROUPS) {
    const entries = [];
    for (const doc of group.docs) {
      if (allDocs.includes(doc)) {
        entries.push(doc);
        placed.add(doc);
      }
    }
    if (entries.length) groups.push({ title: group.title, docs: entries });
  }
  const rest = allDocs.filter((d) => !placed.has(d)).sort((a, b) => titles.get(a).localeCompare(titles.get(b)));
  if (rest.length) groups.push({ title: "More guides", docs: rest });
  return groups;
}

// ---------------------------------------------------------------------------
// Page layout.
// ---------------------------------------------------------------------------

function topNav(sitePath, sourcePath) {
  const link = (label, to, external) =>
    external
      ? `<a href="${to}">${label}</a>`
      : `<a href="${relativeUrl(sitePath, to)}">${label}</a>`;
  return `<nav class="topbar">
  <a class="brand" href="${relativeUrl(sitePath, "index.html")}">${escapeHtml(SITE_TITLE)}</a>
  <div class="topbar-links">
    ${link("Home", "index.html")}
    ${link("Guides", "guides/index.html")}
    ${link("API reference", "api/index.html")}
    ${link("Demo gallery", "gallery.html")}
    ${versionNavigation(sitePath, sourcePath)}
    ${link("GitHub", `https://github.com/${REPO}`, true)}
  </div>
</nav>`;
}

function versionNavigation(sitePath, sourcePath) {
  const entries = DOC_VERSIONS.versions
    .map((entry) => {
      const fallback = `${entry.docs.sourceBase}/README.md`;
      return `<li><a href="${escapeHtml(fallback)}" title="Tagged README fallback for ${escapeHtml(sourcePath)}">${escapeHtml(entry.version)} · ${escapeHtml(entry.status)} fallback</a></li>`;
    })
    .join("\n");
  const shortRevision = SOURCE_REVISION.slice(0, 12);
  return `<details class="version-menu" data-sdk-docs-channel="development" data-sdk-docs-revision="${SOURCE_REVISION}">
  <summary>${escapeHtml(DOC_VERSIONS.development.label)} @ ${shortRevision}</summary>
  <ul><li><a aria-current="page" href="${relativeUrl(sitePath, sitePath)}">development @ ${shortRevision}</a></li>${entries}</ul>
  <p><a href="${relativeUrl(sitePath, "guides/documentation-versions.html")}">Version policy and compatibility</a></p>
</details>`;
}

function sidebar(sitePath, navGroups, titles, activeDoc) {
  const parts = ['<aside class="sidebar"><nav>'];
  for (const group of navGroups) {
    parts.push(`<p class="nav-group">${escapeHtml(group.title)}</p><ul>`);
    for (const doc of group.docs) {
      const to = repoPathToSitePath(doc);
      const cls = doc === activeDoc ? ' class="active"' : "";
      parts.push(`<li${cls}><a href="${relativeUrl(sitePath, to)}">${escapeHtml(titles.get(doc))}</a></li>`);
    }
    parts.push("</ul>");
  }
  parts.push("</nav></aside>");
  return parts.join("\n");
}

function page({ sitePath, sourcePath = "README.md", title, bodyClass, main, sidebarHtml, moduleScripts = [] }) {
  const cssHref = relativeUrl(sitePath, "assets/style.css");
  const scripts = moduleScripts
    .map((script) => `<script type="module" src="${escapeHtml(relativeUrl(sitePath, script))}"></script>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="Documentation for @honua/sdk-js — one TypeScript geospatial client for Esri GeoServices, OGC API, STAC, WMS/WMTS, WFS and OData." />
<link rel="canonical" href="${SITE_URL}${sitePath === "index.html" ? "" : sitePath}" />
<link rel="stylesheet" href="${cssHref}" />
</head>
<body class="${bodyClass}">
${topNav(sitePath, sourcePath)}
<div class="layout">
${sidebarHtml ?? ""}
<main class="content">
${main}
</main>
</div>
<footer class="site-footer">
  <span>${escapeHtml(SITE_TITLE)} documentation · built from <a href="https://github.com/${REPO}">github.com/${REPO}</a></span>
</footer>
${scripts}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Demo gallery from the presentation-safe catalog-v2 site projection.
// ---------------------------------------------------------------------------

async function loadGalleryModel() {
  const projectionBytes = fs.readFileSync(SITE_PROJECTION, "utf8");
  const consumerBytes = fs.readFileSync(SITE_CONSUMER_FIXTURE, "utf8");
  const consumerFixture = parseJsonDocument(consumerBytes, SITE_CONSUMER_FIXTURE_PATH);
  const integrity = await verifyGalleryProjectionIntegrity({ projectionBytes, consumerFixture });
  return createGalleryModel(integrity);
}

function demoSourceUrl(docsPath) {
  const target = path.posix.normalize(docsPath);
  const sitePath = repoPathToSitePath(target);
  if (sitePath) return { href: relativeUrl("gallery.html", sitePath), kind: "guide" };
  return { href: `${BLOB_BASE}/${target}`, kind: "source" };
}

// The gallery is where an evaluating team lands first, so it also points at the
// repo's published, regenerable evidence pages (issue #960). The gallery library
// owns cards only; site-relative links belong here, with the rest of the chrome.
function galleryEvidenceSection() {
  const to = (repoPath) => relativeUrl("gallery.html", repoPathToSitePath(repoPath));
  return `<section class="gallery-evidence">
  <h2 id="published-evidence">Published evidence</h2>
  <p>The same generated-from-committed-artifacts discipline these cards use, applied to the
  claims that are easiest to fake:</p>
  <ul>
    <li><a href="${to("docs/generated/mcp-eval-scorecard.md")}">Cross-model MCP eval scorecard</a> — how different client models score driving Honua's MCP surface, including the zero-LLM control row and every non-passing run.</li>
    <li><a href="${to("docs/generated/coding-agent-scorecard.md")}">Coding-agent evaluation scorecard</a> — whether coding agents write correct SDK code on the first try.</li>
    <li><a href="${to("docs/comparison.md")}">How Honua compares</a> — bundle size, protocol coverage, and time-to-first-map, every external figure carrying a dated evidence record.</li>
  </ul>
</section>`;
}

/** Sample id -> generated playground, read from the standalone decision artifact. */
function loadPlaygroundIndex() {
  if (!fs.existsSync(SAMPLE_PLAYGROUNDS)) return new Map();
  const artifact = parseJsonDocument(fs.readFileSync(SAMPLE_PLAYGROUNDS, "utf8"), SAMPLE_PLAYGROUNDS_PATH);
  if (artifact.format !== "honua.sdk.sample-playgrounds.v1") {
    throw new Error(`${SAMPLE_PLAYGROUNDS_PATH} does not declare the expected format`);
  }
  return new Map((artifact.playgrounds ?? []).map((entry) => [entry.sampleId, entry]));
}

function galleryPage(gallery) {
  const playgrounds = loadPlaygroundIndex();
  const content = renderGalleryContent(gallery, {
    resolveSourceLink: (sample) => demoSourceUrl(sample.source.docsPath),
    resolvePlayground: (sample) => playgrounds.get(sample.id),
  });
  return page({
    sitePath: "gallery.html",
    title: `Demo gallery · ${SITE_TITLE}`,
    bodyClass: "page-gallery",
    main: `${content}\n${galleryEvidenceSection()}`,
    moduleScripts: ["assets/gallery.js"],
  });
}

// ---------------------------------------------------------------------------
// Static assets.
// ---------------------------------------------------------------------------

const STYLE_CSS = `:root{--bg:#ffffff;--fg:#1a202c;--muted:#5a6572;--border:#e2e8f0;--accent:#2b6cb0;--accent-soft:#ebf2fb;--code-bg:#f5f7fa;--sidebar-bg:#fafbfc;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--fg:#e6edf3;--muted:#9aa7b4;--border:#232c36;--accent:#6ba5e0;--accent-soft:#16202c;--code-bg:#161c23;--sidebar-bg:#111820}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.topbar{display:flex;flex-wrap:wrap;align-items:center;gap:1rem;padding:.75rem 1.5rem;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:10}
.topbar .brand{font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
.topbar-links{display:flex;flex-wrap:wrap;gap:1rem;margin-left:auto;font-size:.92rem}
.version-menu{position:relative}
.version-menu summary{cursor:pointer;color:var(--accent)}
.version-menu ul{position:absolute;right:0;max-height:55vh;min-width:20rem;overflow:auto;margin:.4rem 0 0;padding:.5rem;list-style:none;border:1px solid var(--border);border-radius:8px;background:var(--bg);box-shadow:0 6px 20px #0003}
.version-menu li{padding:.1rem .25rem;white-space:nowrap}
.version-menu p{margin:.35rem 0 0;font-size:.8rem}
.layout{display:flex;gap:2rem;max-width:1200px;margin:0 auto;padding:0 1.5rem;align-items:flex-start}
.page-gallery .layout{max-width:1400px}
.sidebar{flex:0 0 250px;position:sticky;top:64px;max-height:calc(100vh - 64px);overflow-y:auto;padding:1.5rem 0;font-size:.9rem}
.sidebar .nav-group{font-weight:700;text-transform:uppercase;letter-spacing:.03em;font-size:.72rem;color:var(--muted);margin:1.2rem 0 .35rem}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li{margin:.1rem 0}
.sidebar li a{display:block;padding:.2rem .5rem;border-radius:5px;color:var(--fg)}
.sidebar li a:hover{background:var(--accent-soft);text-decoration:none}
.sidebar li.active a{background:var(--accent-soft);color:var(--accent);font-weight:600}
.content{flex:1 1 auto;min-width:0;padding:1.5rem 0 3rem;max-width:100%}
.content h1{font-size:2rem;line-height:1.2;margin-top:.5rem}
.content h2{margin-top:2rem;padding-bottom:.3rem;border-bottom:1px solid var(--border)}
.content img{max-width:100%;height:auto}
.content pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto;font-size:.88rem}
.content code{background:var(--code-bg);padding:.15em .4em;border-radius:4px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.content pre code{background:none;padding:0;font-size:1em}
.content table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;margin:1rem 0}
.content th,.content td{border:1px solid var(--border);padding:.45rem .7rem;text-align:left}
.content th{background:var(--sidebar-bg)}
.content blockquote{margin:1rem 0;padding:.4rem 1rem;border-left:4px solid var(--accent);background:var(--accent-soft);border-radius:0 6px 6px 0}
.content blockquote p{margin:.4rem 0}
.hero{padding:2.5rem 0 1rem}
.hero h1{font-size:2.4rem;margin:0 0 .5rem}
.hero .tagline{font-size:1.15rem;color:var(--muted);max-width:60ch}
.cta{display:inline-block;margin:.4rem .6rem .4rem 0;padding:.55rem 1.1rem;border-radius:8px;background:var(--accent);color:#fff;font-weight:600}
.cta:hover{text-decoration:none;opacity:.92}
.cta.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.gallery-provenance{margin:1rem 0;border:1px solid var(--border);border-radius:8px;padding:.6rem .8rem;background:var(--sidebar-bg)}
.gallery-provenance summary,.demo-card-details summary{cursor:pointer;font-weight:700;color:var(--accent)}
.gallery-provenance .demo-facts{margin:.75rem 0 .25rem}
.gallery-qualification-note{color:var(--muted);font-size:.9rem}
.gallery-controls{display:flex;flex-wrap:wrap;align-items:end;gap:.8rem;margin:1.25rem 0;padding:1rem;border:1px solid var(--border);border-radius:10px;background:var(--sidebar-bg)}
.gallery-control{display:flex;flex:1 1 200px;flex-direction:column;gap:.25rem}
.gallery-control label{font-size:.82rem;font-weight:700}
.gallery-control input,.gallery-control select,.gallery-controls button{min-height:2.6rem;border:1px solid var(--border);border-radius:6px;padding:.45rem .65rem;color:var(--fg);background:var(--bg);font:inherit}
.gallery-controls button{cursor:pointer;color:var(--accent);font-weight:600}
.gallery-controls button:disabled{cursor:default;color:var(--muted);opacity:.65}
.gallery-results{color:var(--muted)}
.gallery-empty{padding:1rem;border:1px dashed var(--border);border-radius:8px;color:var(--muted)}
.demo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:1rem;margin:1rem 0}
.demo-card{border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.2rem;background:var(--sidebar-bg);display:flex;flex-direction:column}
.demo-card--merge,.demo-card--replace,.demo-card--retire{border-inline-start:4px solid var(--accent)}
.demo-card-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:.5rem}
.demo-card h3{margin:.1rem 0 .25rem}
.demo-badges{display:flex;flex-wrap:wrap;gap:.35rem}
.demo-badge{border:1px solid var(--border);border-radius:999px;padding:.1rem .5rem;background:var(--accent-soft);font-size:.75rem;font-weight:700}
.demo-badge--lifecycle{text-transform:uppercase;letter-spacing:.02em}
.demo-card p{color:var(--muted);margin:0 0 .8rem}
.demo-card .demo-id{flex:0 0 auto}
.demo-card .demo-summary{color:var(--fg)}
.demo-facts{display:grid;grid-template-columns:minmax(7.5rem,auto) 1fr;gap:.5rem .75rem;margin:.25rem 0 1rem;font-size:.86rem}
.demo-facts--essential{gap:.35rem .65rem;margin-bottom:.7rem}
.demo-facts dt{font-weight:700;color:var(--muted)}
.demo-facts dd{min-width:0;margin:0;overflow-wrap:anywhere}
.demo-evidence-line{display:block}
.demo-evidence-expiry{white-space:normal}
.demo-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin:0;padding:0;list-style:none}
.demo-tags code{white-space:nowrap}
.demo-none{color:var(--muted)}
.demo-link{margin:.1rem 0 .75rem;font-weight:600}
.demo-link--playground{display:inline-block;margin-right:.75rem;font-size:.86rem}
.demo-card-details{border-top:1px solid var(--border);padding-top:.55rem}
.demo-card-details .demo-facts{margin:.75rem 0 .2rem}
.site-footer{border-top:1px solid var(--border);margin-top:2rem;padding:1.5rem;text-align:center;color:var(--muted);font-size:.85rem}
@media (max-width:820px){.layout{flex-direction:column;padding:0 1rem}.sidebar{position:static;flex-basis:auto;max-height:none;width:100%;border-bottom:1px solid var(--border)}}
@media (max-width:520px){.demo-facts{grid-template-columns:1fr}.demo-facts dd{margin-bottom:.35rem}}
`;

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(rel, content) {
  const abs = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const started = Date.now();
  const gallery = await loadGalleryModel();
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const install = fs.readFileSync(path.join(ROOT, "INSTALL.md"), "utf8");

  // Guide corpus = INSTALL.md + every docs/**/*.md.
  const guideDocs = ["INSTALL.md", ...walkMarkdown(path.join(ROOT, "docs"))];
  const titles = new Map();
  for (const doc of guideDocs) {
    const md = doc === "INSTALL.md" ? install : fs.readFileSync(path.join(ROOT, doc), "utf8");
    titles.set(doc, extractH1(md, path.basename(doc, ".md")));
  }
  const navGroups = buildNav(guideDocs, titles);

  let pageCount = 0;

  // Landing page from README.
  const landingMain = `<header class="hero">
  <h1>${escapeHtml(SITE_TITLE)}</h1>
  <p class="tagline">MapLibre gives you the map. Honua gives you everything else: typed clients for Esri GeoServices, OGC API (Features / Tiles / Maps / Processes), STAC, WMS/WMTS, WFS 2.0, and OData v4 — plus a one-call data→map bridge and a drop-in ArcGIS migration path.</p>
  <p>
    <a class="cta" href="guides/quickstart.html">Building on MapLibre → First Map</a>
    <a class="cta" href="guides/widget-survival-guide.html">Leaving ArcGIS → widget survival guide</a>
    <a class="cta secondary" href="api/index.html">API reference</a>
    <a class="cta secondary" href="gallery.html">Demo gallery</a>
  </p>
  <p class="hero-note">Classic Esri widgets are deprecated at ArcGIS JS 5.0 and removed at 6.0 (planned Q1 2027). Scan your app: <code>npm run scan:arcgis:widgets -- ./src</code>.</p>
</header>
${renderMarkdown(readme, { sourcePath: "README.md", sitePath: "index.html" })}`;
  writeFile("index.html", page({ sitePath: "index.html", title: `${SITE_TITLE} — Documentation`, bodyClass: "page-home", main: landingMain }));
  pageCount++;

  // Guides index.
  const guidesIndexMain = [`<h1>Guides</h1>`, `<p>The full ${SITE_TITLE} guide corpus.</p>`];
  for (const group of navGroups) {
    guidesIndexMain.push(`<h2>${escapeHtml(group.title)}</h2><ul>`);
    for (const doc of group.docs) {
      const to = repoPathToSitePath(doc);
      guidesIndexMain.push(`<li><a href="${relativeUrl("guides/index.html", to)}">${escapeHtml(titles.get(doc))}</a></li>`);
    }
    guidesIndexMain.push("</ul>");
  }
  writeFile(
    "guides/index.html",
    page({
      sitePath: "guides/index.html",
      sourcePath: "docs/guide.md",
      title: `Guides · ${SITE_TITLE}`,
      bodyClass: "page-guides",
      main: guidesIndexMain.join("\n"),
      sidebarHtml: sidebar("guides/index.html", navGroups, titles, null),
    }),
  );
  pageCount++;

  // Every guide page.
  for (const doc of guideDocs) {
    const sitePath = repoPathToSitePath(doc);
    const md = doc === "INSTALL.md" ? install : fs.readFileSync(path.join(ROOT, doc), "utf8");
    const main = renderMarkdown(md, { sourcePath: doc, sitePath });
    writeFile(
      sitePath,
      page({
        sitePath,
        sourcePath: doc,
        title: `${titles.get(doc)} · ${SITE_TITLE}`,
        bodyClass: "page-guide",
        main,
        sidebarHtml: sidebar(sitePath, navGroups, titles, doc),
      }),
    );
    pageCount++;
  }

  // Demo gallery.
  writeFile("gallery.html", galleryPage(gallery));
  pageCount++;

  // Assets.
  writeFile("assets/style.css", STYLE_CSS);
  writeFile("assets/gallery.js", fs.readFileSync(path.join(ROOT, "scripts/lib/docs-gallery-client.mjs"), "utf8"));
  // Disable Jekyll so paths beginning with `_` (if any) survive Pages.
  writeFile(".nojekyll", "");

  // AI-discoverability manifests at the SITE root — the site (and README)
  // advertise /llms.txt; serving 404s there undercuts the whole story.
  // Copied verbatim from the repo copies, which verify:llms keeps fresh.
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, name));
  }
  fs.writeFileSync(path.join(OUT, "versions.json"), serializeDocsVersions(BUILT_DOC_VERSIONS));

  // TypeDoc API reference.
  let apiPages = 0;
  if (fs.existsSync(API_SRC)) {
    copyDir(API_SRC, path.join(OUT, "api"));
    decorateApiIndex();
    apiPages = walkCount(path.join(OUT, "api"), ".html");
  } else {
    process.stderr.write(`warning: ${path.relative(ROOT, API_SRC)} missing — run \`npm run docs:api\` first; /api will 404\n`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `built docs site -> ${path.relative(ROOT, OUT)} (${pageCount} content pages, ${gallery.cardCount} gallery cards, ${apiPages} API pages) in ${secs}s\n`,
  );
}

function decorateApiIndex() {
  const apiIndex = path.join(OUT, "api", "index.html");
  if (!fs.existsSync(apiIndex)) throw new Error("TypeDoc output is missing api/index.html");
  const html = fs.readFileSync(apiIndex, "utf8");
  const archived = DOC_VERSIONS.versions
    .map(
      (entry) =>
        `<li><a href="${escapeHtml(entry.docs.sourceBase)}/README.md">${escapeHtml(entry.version)} · tagged README fallback</a> · <a href="${escapeHtml(entry.releaseUrl)}">release notes</a></li>`,
    )
    .join("");
  const shortRevision = SOURCE_REVISION.slice(0, 12);
  const banner = `<aside data-sdk-docs-channel="development" data-sdk-docs-revision="${SOURCE_REVISION}" style="padding:.65rem 1rem;border:1px solid #8886;margin:1rem;border-radius:.5rem">
  <strong>@honua/sdk-js ${escapeHtml(DOC_VERSIONS.development.label)} @ ${shortRevision}</strong> · package baseline ${escapeHtml(DOC_VERSIONS.development.packageBaseline)} ·
  <a href="../guides/documentation-versions.html">versions, compatibility, and migration</a>
  <details><summary>Switch documentation version</summary><ul><li><a aria-current="page" href="index.html">development @ ${shortRevision}</a></li>${archived}</ul></details>
</aside>`;
  if (!html.includes("<body")) throw new Error("TypeDoc api/index.html has no body element");
  fs.writeFileSync(apiIndex, html.replace(/(<body[^>]*>)/, `$1${banner}`));
}

function walkCount(dir, ext) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += walkCount(full, ext);
    else if (entry.name.endsWith(ext)) n++;
  }
  return n;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`docs site build failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
