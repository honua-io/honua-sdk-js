/**
 * Qualify the 2026.1 bounded setup: immutable local install, server-authored
 * workflow view, and published-layer style/render. The pinned manifest is the
 * enabled catalog. This module does not invent a profile switch or a 441-tool
 * success count.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HonuaAdminClient } from "../control-plane/admin-client.js";
import {
  LOCAL_AGENT_GRANTS,
  LOCAL_INSTALL_MCP_PACKAGE,
  LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
  LOCAL_INSTALL_MCP_PACKAGE_NAME,
  LOCAL_INSTALL_MCP_PACKAGE_VERSION,
  LOCAL_INSTALL_SERVER_IMAGE,
  type LocalInstallRuntime,
  getHonuaLocalStatus,
  inspectLocalAgentAccess,
  readVerifiedLocalEnv,
  runLocalInstallCommand,
} from "../local-install.js";
import { verifyPrivateFile } from "../private-file.js";
import { resolveExecutableFromPath } from "../process-executable.js";
import { McpClient } from "../studio-agent/mcp-client.js";
import { assertRenderedPng } from "./rendered-png.js";

export const BOUNDED_QUALIFICATION_SCHEMA = "honua.bounded-setup-qualification/v1" as const;
export const GEOMETRY_BUFFER_TASK = "geometry.buffer";
export const BOUNDED_QUALIFICATION_UNSUPPORTED = [
  "full Admin MCP roster",
  "analysis profile",
  "esri-gp profile",
  "guessed Mcp__Profiles switch",
  "hard-coded 441-tool success denominator",
  "dashboard publication",
] as const;

const RENDER_WIDTH = 512;
const RENDER_HEIGHT = 512;
const RENDER_MIN_BYTES = 1024;

export interface BoundedManifest {
  readonly schemaVersion: "honua.setup-catalog-manifest/v1";
  readonly candidateId: string;
  readonly serverImage: string;
  readonly packages: readonly { readonly name: string; readonly version: string; readonly integrity: string }[];
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly view: string;
  readonly revision: string;
  readonly revisionDigest: string;
  readonly membershipDigest: string;
  readonly descriptorDigest: string;
  readonly tools: readonly ManifestTool[];
}

type ManifestTool = { readonly name: string } & Record<string, unknown>;

export interface StyleRenderCapture {
  readonly discoveredStyleId: string;
  readonly applied: boolean;
  readonly appliedStyleId: string;
  readonly appliedStyleVersion: string;
  readonly confirmedStyleId: string;
  readonly confirmedStyleVersion: string;
  readonly renderedStyleId: string;
  readonly width: number;
  readonly height: number;
  readonly mediaType: string;
  readonly uri: string;
  readonly png: Uint8Array;
}

export interface BoundedQualificationEvidence {
  readonly generatedAt: string;
  readonly manifest: BoundedManifest;
  readonly manifestSha256: string;
  readonly install: {
    readonly installed: boolean;
    readonly ready: boolean;
    readonly baseUrl?: string;
    readonly configuredImage?: string;
    readonly repoDigests: readonly string[];
    readonly inspectError?: string;
    readonly composeText?: string;
    readonly mcpPackageArgument?: string;
    readonly mcpRemoteUrl?: string;
  };
  readonly access?:
    | {
        readonly id: string;
        readonly name: string;
        readonly requestedGrants: readonly string[];
        readonly effectiveGrants: readonly string[];
        readonly canAuthenticate: true;
      }
    | { readonly error: string };
  readonly adminVersion?:
    | { readonly version: string; readonly metadataApiVersion: string }
    | { readonly error: string };
  readonly discovery?: {
    readonly serverInfo?: { readonly name?: string; readonly version?: string };
    readonly tools: readonly ManifestTool[];
    readonly metadata?: Record<string, unknown>;
    readonly pages: number;
    readonly error?: string;
  };
  readonly catalogReceipt?: unknown;
  readonly style?: StyleRenderCapture | { readonly error: string };
}

export interface BoundedQualificationReceipt {
  readonly schemaVersion: typeof BOUNDED_QUALIFICATION_SCHEMA;
  readonly release: "2026.1";
  readonly scope: "local-setup+bounded-discovery+style-render";
  readonly generatedAt: string;
  readonly pass: boolean;
  readonly candidateId: string;
  readonly serverImage: string;
  readonly packages: BoundedManifest["packages"];
  readonly workflowView: string;
  readonly revision: string;
  readonly revisionDigest: string;
  readonly unsupported: typeof BOUNDED_QUALIFICATION_UNSUPPORTED;
  readonly install: {
    readonly ready: boolean;
    readonly serverImageMatchesPin: boolean;
    readonly repoDigestVerified: boolean;
    readonly baseUrl?: string;
    readonly mcpPackage: {
      readonly name: string;
      readonly version: string;
      readonly integrity: string;
      readonly matchesGeneratedConfig: boolean;
    };
  };
  readonly auth?: {
    readonly credentialId: string;
    readonly name: string;
    readonly requestedGrants: readonly string[];
    readonly effectiveGrants: readonly string[];
    readonly canAuthenticate: true;
    readonly grantsMatch: boolean;
  };
  readonly server: {
    readonly mcp?: { readonly name: string; readonly version: string };
    readonly adminVersion?: string;
    readonly metadataApiVersion?: string;
  };
  readonly discovery: {
    readonly pages: number;
    readonly geometryBufferTool?: string;
    readonly liveHttpDescriptorSha256?: string;
    readonly catalogParity?: {
      readonly directDescriptorSha256: string;
      readonly proxiedDescriptorSha256: string;
      readonly pass: boolean;
    };
  };
  readonly styleRender?: {
    readonly styleId: string;
    readonly mediaType: string;
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly imageSha256: string;
    readonly visiblePixelCount: number;
    readonly decodedPixelSha256: string;
    readonly uri: string;
  };
  readonly differences: readonly string[];
}

export function parseBoundedManifest(bytes: string, expectedSha256: string): BoundedManifest {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error("Setup manifest SHA-256 does not match the independently pinned digest");
  }
  const value: unknown = JSON.parse(bytes);
  if (!isRecord(value) || value.schemaVersion !== "honua.setup-catalog-manifest/v1") {
    throw new Error("Expected honua.setup-catalog-manifest/v1");
  }
  for (const key of ["candidateId", "view", "revision"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "") throw new Error(`Manifest requires ${key}`);
  }
  if (value.view === "full") throw new Error("Setup qualification requires a bounded server-authored view");
  if (typeof value.serverImage !== "string" || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value.serverImage)) {
    throw new Error("Manifest requires an immutable server image digest");
  }
  for (const key of ["revisionDigest", "membershipDigest", "descriptorDigest"] as const) {
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) {
      throw new Error(`Manifest requires server-authored ${key}`);
    }
  }
  if (
    !isRecord(value.serverInfo) ||
    typeof value.serverInfo.name !== "string" ||
    typeof value.serverInfo.version !== "string"
  ) {
    throw new Error("Manifest requires the server initialize identity");
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.some(
      (pkg) =>
        !isRecord(pkg) ||
        typeof pkg.name !== "string" ||
        typeof pkg.version !== "string" ||
        typeof pkg.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity),
    )
  ) {
    throw new Error("Manifest requires exact package versions and sha512 integrities");
  }
  if (!Array.isArray(value.tools) || value.tools.length === 0) throw new Error("Manifest has no enabled tools");
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.inputSchema)) {
      throw new Error("Manifest tool is missing a name or input schema");
    }
    if (names.has(tool.name)) throw new Error("Manifest repeats a tool name");
    names.add(tool.name);
  }
  return value as unknown as BoundedManifest;
}

export function liveDescriptorSha256(tools: readonly ManifestTool[]): string {
  return sha256(stableJson([...tools].map(normalizeTool).sort((left, right) => left.name.localeCompare(right.name))));
}

export function geometryBufferTool(tools: readonly ManifestTool[]): string | undefined {
  return tools.find(
    (tool) => tool.name === GEOMETRY_BUFFER_TASK || stableJson(tool).includes(`"${GEOMETRY_BUFFER_TASK}"`),
  )?.name;
}

export function assembleBoundedQualification(evidence: BoundedQualificationEvidence): BoundedQualificationReceipt {
  const differences: string[] = [];
  const { manifest, install } = evidence;
  const imageMatches =
    install.configuredImage === LOCAL_INSTALL_SERVER_IMAGE && install.configuredImage === manifest.serverImage;
  if (!install.installed) differences.push("local install directory has no verified Honua environment");
  if (!imageMatches) {
    differences.push("configured server image is not the immutable release pin in the setup manifest");
  }
  if (!install.ready) differences.push("local install is not ready at /healthz/ready");
  if (install.inspectError) differences.push(`running server image digest was not verified: ${install.inspectError}`);
  else if (install.configuredImage && !install.repoDigests.includes(install.configuredImage)) {
    differences.push("docker image inspect did not report the pinned server image digest");
  }
  if (install.composeText?.includes("Mcp__Profiles")) {
    differences.push("refusing a guessed Mcp__Profiles switch; bounded qualification uses the server-authored view");
  }
  const mcpMatches = install.mcpPackageArgument === LOCAL_INSTALL_MCP_PACKAGE;
  if (!mcpMatches) differences.push("generated MCP client config is not the pinned @honua/mcp-server package");
  if (install.baseUrl && install.mcpRemoteUrl && install.mcpRemoteUrl !== `${install.baseUrl}/mcp`) {
    differences.push("generated MCP remote URL does not match the local install base URL");
  }

  let auth: BoundedQualificationReceipt["auth"];
  if (!evidence.access) differences.push("local agent credential was not inspected");
  else if ("error" in evidence.access) differences.push(evidence.access.error);
  else {
    const grantsMatch =
      sameStrings(evidence.access.requestedGrants, LOCAL_AGENT_GRANTS) &&
      sameStrings(evidence.access.effectiveGrants, evidence.access.requestedGrants);
    auth = {
      credentialId: evidence.access.id,
      name: evidence.access.name,
      requestedGrants: evidence.access.requestedGrants,
      effectiveGrants: evidence.access.effectiveGrants,
      canAuthenticate: true,
      grantsMatch,
    };
    if (!grantsMatch) differences.push("effective grants do not match the supported local-agent grants");
  }

  const server: {
    mcp?: { name: string; version: string };
    adminVersion?: string;
    metadataApiVersion?: string;
  } = {};
  if (!evidence.adminVersion) differences.push("server identity was not read");
  else if ("error" in evidence.adminVersion) differences.push(evidence.adminVersion.error);
  else {
    server.adminVersion = evidence.adminVersion.version;
    server.metadataApiVersion = evidence.adminVersion.metadataApiVersion;
    if (!evidence.adminVersion.version.trim()) differences.push("admin version identity was empty");
  }

  const discovery: {
    pages: number;
    geometryBufferTool?: string;
    liveHttpDescriptorSha256?: string;
    catalogParity?: {
      directDescriptorSha256: string;
      proxiedDescriptorSha256: string;
      pass: boolean;
    };
  } = { pages: evidence.discovery?.pages ?? 0 };
  const bufferTool = geometryBufferTool(manifest.tools);
  if (!bufferTool) {
    differences.push(
      `pinned setup manifest does not advertise ${GEOMETRY_BUFFER_TASK}; the bounded view must include that existing task`,
    );
  } else discovery.geometryBufferTool = bufferTool;

  if (!evidence.discovery) differences.push("bounded tool inventory was not read");
  else if (evidence.discovery.error) differences.push(evidence.discovery.error);
  else {
    discovery.pages = evidence.discovery.pages;
    if (evidence.discovery.pages < 1) differences.push("bounded tool inventory was not read to exhaustion");
    const info = evidence.discovery.serverInfo;
    if (!info?.name || !info.version) differences.push("HTTP: server identity was not initialized");
    else {
      server.mcp = { name: info.name, version: info.version };
      if (stableJson(info) !== stableJson(manifest.serverInfo)) {
        differences.push("HTTP: server identity differs from the pin");
      }
    }
    const metadata = evidence.discovery.metadata;
    if (!metadata) differences.push("HTTP: tools/list omitted the server-authored view metadata");
    else {
      for (const key of ["view", "revision", "revisionDigest", "membershipDigest", "descriptorDigest"] as const) {
        if (metadata[key] !== manifest[key]) differences.push(`HTTP: ${key} differs from the pin`);
      }
      if (metadata.toolCount !== undefined && metadata.toolCount !== manifest.tools.length) {
        differences.push("HTTP: declared toolCount differs from the enabled manifest");
      }
    }
    const names = evidence.discovery.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) differences.push("HTTP: duplicate tool names");
    const actual = new Map(evidence.discovery.tools.map((tool) => [tool.name, normalizeTool(tool)]));
    const expected = new Map(manifest.tools.map((tool) => [tool.name, normalizeTool(tool)]));
    for (const name of expected.keys()) {
      if (!actual.has(name)) {
        differences.push(`HTTP: missing enabled tool ${name}; check candidate view and effective permissions`);
      } else if (stableJson(actual.get(name)) !== stableJson(expected.get(name))) {
        differences.push(`HTTP: ${name} descriptor differs from the pin`);
      }
    }
    for (const name of actual.keys()) {
      if (!expected.has(name)) differences.push(`HTTP: unexpected tool ${name}`);
    }
    discovery.liveHttpDescriptorSha256 = liveDescriptorSha256(evidence.discovery.tools);
    differences.push(...catalogDifferences(evidence.catalogReceipt, manifest, evidence.manifestSha256));
    const catalog = catalogHashes(evidence.catalogReceipt);
    if (catalog) discovery.catalogParity = catalog;
  }

  let styleRender: BoundedQualificationReceipt["styleRender"];
  if (!evidence.style) differences.push("style/render sequence was not executed");
  else if ("error" in evidence.style) differences.push(evidence.style.error);
  else {
    const style = evidence.style;
    if (style.applied !== true) differences.push("style no-op: honua_apply_style_preset returned applied: false");
    if (style.appliedStyleId !== style.discoveredStyleId || style.confirmedStyleId !== style.discoveredStyleId) {
      differences.push("style read-back does not match the discovered preset");
    }
    if (style.confirmedStyleVersion !== style.appliedStyleVersion) {
      differences.push("style read-back version does not match the apply result");
    }
    if (style.renderedStyleId !== style.discoveredStyleId) {
      differences.push("render layers[].styleId does not match the discovered preset");
    }
    try {
      const judged = assertRenderedPng(style.png, style.mediaType, {
        uri: style.uri,
        mediaType: style.mediaType,
        width: style.width,
        height: style.height,
        minByteLength: style.width * style.height >= RENDER_WIDTH * RENDER_HEIGHT ? RENDER_MIN_BYTES : 64,
      });
      styleRender = {
        styleId: style.discoveredStyleId,
        mediaType: judged.mediaType,
        width: judged.width,
        height: judged.height,
        byteLength: judged.byteLength,
        imageSha256: judged.imageSha256,
        visiblePixelCount: judged.visiblePixelCount,
        decodedPixelSha256: judged.decodedPixelSha256,
        uri: judged.uri,
      };
    } catch (error) {
      differences.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    schemaVersion: BOUNDED_QUALIFICATION_SCHEMA,
    release: "2026.1",
    scope: "local-setup+bounded-discovery+style-render",
    generatedAt: evidence.generatedAt,
    pass: differences.length === 0,
    candidateId: manifest.candidateId,
    serverImage: manifest.serverImage,
    packages: manifest.packages,
    workflowView: manifest.view,
    revision: manifest.revision,
    revisionDigest: manifest.revisionDigest,
    unsupported: BOUNDED_QUALIFICATION_UNSUPPORTED,
    install: {
      ready: install.ready,
      serverImageMatchesPin: imageMatches,
      repoDigestVerified: Boolean(install.configuredImage && install.repoDigests.includes(install.configuredImage)),
      ...(install.baseUrl ? { baseUrl: install.baseUrl } : {}),
      mcpPackage: {
        name: LOCAL_INSTALL_MCP_PACKAGE_NAME,
        version: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
        integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
        matchesGeneratedConfig: mcpMatches,
      },
    },
    ...(auth ? { auth } : {}),
    server,
    discovery,
    ...(styleRender ? { styleRender } : {}),
    differences,
  };
}

export interface QualifyBoundedSetupOptions {
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly catalogReceiptPath: string;
  readonly outputPath?: string;
  readonly serviceId?: string;
  readonly layerId?: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly styleEvidencePath?: string;
  readonly stylePngPath?: string;
  readonly executeStyle?: boolean;
  readonly now?: () => string;
}

export async function qualifyBoundedSetup(
  options: QualifyBoundedSetupOptions,
  runtime: LocalInstallRuntime = {},
): Promise<BoundedQualificationReceipt> {
  const directory = path.resolve(options.directory);
  const manifestBytes = await readFile(options.manifestPath, "utf8");
  const manifest = parseBoundedManifest(manifestBytes, options.manifestSha256);
  const env = await readVerifiedLocalEnv(directory);
  const status = await getHonuaLocalStatus(directory, runtime);
  const composeText = await readFile(path.join(directory, "compose.yaml"), "utf8").catch(() => undefined);
  const mcpConfig = await readMcpConfig(path.join(directory, ".mcp.json"));
  const configuredImage = env.HONUA_SERVER_IMAGE;
  let repoDigests: string[] = [];
  let inspectError: string | undefined;
  if (configuredImage) {
    try {
      const docker = runtime.run
        ? "docker"
        : await resolveExecutableFromPath("docker", { excludedDirectory: directory });
      const run = runtime.run ?? runLocalInstallCommand;
      const inspected = await run(
        docker,
        ["image", "inspect", configuredImage, "--format", "{{json .RepoDigests}}"],
        directory,
      );
      if (inspected.exitCode !== 0) inspectError = inspected.stderr.trim() || "docker image inspect failed";
      else repoDigests = parseDigests(inspected.stdout);
    } catch (error) {
      inspectError = error instanceof Error ? error.message : String(error);
    }
  }
  const secret = env.HONUA_ADMIN_KEY;
  const scrubbed = (error: unknown) => scrub(error instanceof Error ? error.message : String(error), secret);
  let access: BoundedQualificationEvidence["access"];
  let adminVersion: BoundedQualificationEvidence["adminVersion"];
  let discovery: BoundedQualificationEvidence["discovery"];
  let style: BoundedQualificationEvidence["style"];
  if (secret && status.baseUrl) {
    try {
      access = await inspectLocalAgentAccess(status.baseUrl, secret, runtime.fetchFn);
    } catch (error) {
      access = { error: scrubbed(error) };
    }
    try {
      adminVersion = await readAdminVersion(status.baseUrl, secret, runtime.fetchFn);
    } catch (error) {
      adminVersion = { error: scrubbed(error) };
    }
    try {
      const client = new McpClient({
        baseUrl: status.baseUrl,
        apiKey: secret,
        workflowView: manifest.view,
        clientName: "honua-bounded-qualification",
        clientVersion: "2026.1",
        ...(runtime.fetchFn ? { fetchImpl: runtime.fetchFn } : {}),
      });
      const listing = await client.listAllTools({ view: manifest.view });
      discovery = {
        serverInfo: client.serverInfo?.serverInfo,
        tools: listing.tools as unknown as ManifestTool[],
        ...(listing.metadata ? { metadata: listing.metadata } : {}),
        pages: listing.pages,
      };
      if (options.executeStyle) {
        if (!options.serviceId || !options.layerId || !options.bbox) {
          style = { error: "style/render requires --service-id, --layer-id, and --bbox" };
        } else {
          try {
            style = await runStyleRender(client, {
              serviceId: options.serviceId,
              layerId: options.layerId,
              bbox: options.bbox,
            });
          } catch (error) {
            style = { error: scrubbed(error) };
          }
        }
      }
    } catch (error) {
      discovery = { tools: [], pages: 0, error: scrubbed(error) };
    }
  } else if (!secret) {
    access = { error: "local install has no admin credential to inspect" };
  }
  if (!options.executeStyle && (options.styleEvidencePath || options.stylePngPath)) {
    style = await readStyleEvidence(options.styleEvidencePath, options.stylePngPath);
  }
  const catalogReceipt = JSON.parse(await readFile(options.catalogReceiptPath, "utf8")) as unknown;
  const receipt = assembleBoundedQualification({
    generatedAt: options.now?.() ?? new Date().toISOString(),
    manifest,
    manifestSha256: options.manifestSha256,
    install: {
      installed: status.installed,
      ready: status.ready,
      ...(status.baseUrl ? { baseUrl: status.baseUrl } : {}),
      ...(configuredImage ? { configuredImage } : {}),
      repoDigests,
      ...(inspectError ? { inspectError: scrub(inspectError, secret) } : {}),
      ...(composeText !== undefined ? { composeText } : {}),
      ...(mcpConfig.packageArgument ? { mcpPackageArgument: mcpConfig.packageArgument } : {}),
      ...(mcpConfig.remoteUrl ? { mcpRemoteUrl: mcpConfig.remoteUrl } : {}),
    },
    ...(access ? { access } : {}),
    ...(adminVersion ? { adminVersion } : {}),
    ...(discovery ? { discovery } : {}),
    catalogReceipt,
    ...(style ? { style } : {}),
  });
  if (options.outputPath) {
    await writeFile(options.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return receipt;
}

async function runStyleRender(
  client: McpClient,
  target: {
    readonly serviceId: string;
    readonly layerId: string;
    readonly bbox: readonly [number, number, number, number];
  },
): Promise<StyleRenderCapture | { readonly error: string }> {
  const baseline = structured(
    await client.callTool("honua_get_style", {
      serviceId: target.serviceId,
      layerId: target.layerId,
      includeStylesheet: true,
    }),
  );
  if (typeof baseline.styleVersion !== "string") return { error: "honua_get_style did not return a styleVersion" };
  const catalog = structured(await client.callTool("honua_get_style", {}));
  const styles = Array.isArray(catalog.styles) ? catalog.styles : [];
  const first = styles.find((entry) => isRecord(entry) && typeof entry.styleId === "string");
  if (!first || !isRecord(first) || typeof first.styleId !== "string") {
    return { error: "server published no style preset to discover" };
  }
  const discoveredStyleId = first.styleId;
  const applied = structured(
    await client.callTool("honua_apply_style_preset", {
      serviceId: target.serviceId,
      layerId: target.layerId,
      styleId: discoveredStyleId,
    }),
  );
  const confirmed = structured(
    await client.callTool("honua_get_style", { serviceId: target.serviceId, layerId: target.layerId }),
  );
  const rendered = structured(
    await client.callTool("honua_render_map", {
      layers: [{ serviceId: target.serviceId, layerId: target.layerId }],
      bbox: [...target.bbox],
      bboxSrid: 4326,
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
    }),
  );
  const image = isRecord(rendered.image) ? rendered.image : undefined;
  const layer = Array.isArray(rendered.layers) ? rendered.layers[0] : undefined;
  if (!image || typeof image.uri !== "string" || typeof image.width !== "number" || typeof image.height !== "number") {
    return { error: "honua_render_map did not return an image uri and dimensions" };
  }
  const resource = await client.readResource(image.uri);
  const blob = readBlob(resource, image.uri);
  return {
    discoveredStyleId,
    applied: applied.applied === true,
    appliedStyleId: typeof applied.styleId === "string" ? applied.styleId : "",
    appliedStyleVersion: typeof applied.styleVersion === "string" ? applied.styleVersion : "",
    confirmedStyleId: typeof confirmed.styleId === "string" ? confirmed.styleId : "",
    confirmedStyleVersion: typeof confirmed.styleVersion === "string" ? confirmed.styleVersion : "",
    renderedStyleId: isRecord(layer) && typeof layer.styleId === "string" ? layer.styleId : "",
    width: image.width,
    height: image.height,
    mediaType: blob.mimeType ?? "image/png",
    uri: image.uri,
    png: blob.bytes,
  };
}

async function readStyleEvidence(
  evidencePath: string | undefined,
  pngPath: string | undefined,
): Promise<StyleRenderCapture | { readonly error: string }> {
  if (!evidencePath || !pngPath) return { error: "style/render replay requires both --style-evidence and --style-png" };
  const parsed: unknown = JSON.parse(await readFile(evidencePath, "utf8"));
  if (!isRecord(parsed)) return { error: "style evidence must be a JSON object" };
  const png = new Uint8Array(await readFile(pngPath));
  const required = [
    "discoveredStyleId",
    "appliedStyleId",
    "appliedStyleVersion",
    "confirmedStyleId",
    "confirmedStyleVersion",
    "renderedStyleId",
    "mediaType",
    "uri",
  ] as const;
  for (const key of required) {
    if (typeof parsed[key] !== "string") return { error: `style evidence requires ${key}` };
  }
  if (typeof parsed.applied !== "boolean" || typeof parsed.width !== "number" || typeof parsed.height !== "number") {
    return { error: "style evidence requires applied, width, and height" };
  }
  return {
    discoveredStyleId: parsed.discoveredStyleId as string,
    applied: parsed.applied,
    appliedStyleId: parsed.appliedStyleId as string,
    appliedStyleVersion: parsed.appliedStyleVersion as string,
    confirmedStyleId: parsed.confirmedStyleId as string,
    confirmedStyleVersion: parsed.confirmedStyleVersion as string,
    renderedStyleId: parsed.renderedStyleId as string,
    width: parsed.width,
    height: parsed.height,
    mediaType: parsed.mediaType as string,
    uri: parsed.uri as string,
    png,
  };
}

function catalogDifferences(value: unknown, manifest: BoundedManifest, manifestSha256: string): string[] {
  if (!isRecord(value) || value.schemaVersion !== "honua.setup-catalog-parity/v1") {
    return ["catalog receipt must use honua.setup-catalog-parity/v1"];
  }
  const differences: string[] = [];
  if (value.scope !== "catalog-parity-only") differences.push("catalog receipt scope is not catalog-parity-only");
  if (value.manifestSha256 !== manifestSha256) differences.push("catalog receipt is not bound to this manifest digest");
  if (value.serverImage !== manifest.serverImage)
    differences.push("catalog receipt server image differs from the manifest");
  if (value.view !== manifest.view) differences.push("catalog receipt view differs from the manifest");
  if (value.pass !== true) differences.push("catalog receipt did not pass HTTP/stdio parity");
  if (typeof value.directDescriptorSha256 !== "string" || typeof value.proxiedDescriptorSha256 !== "string") {
    differences.push("catalog receipt is missing HTTP/stdio descriptor hashes");
  } else if (value.directDescriptorSha256 !== value.proxiedDescriptorSha256) {
    differences.push("HTTP/stdio descriptor hashes differ");
  }
  if (value.candidateId !== undefined && value.candidateId !== manifest.candidateId) {
    differences.push("catalog receipt candidate differs from the manifest");
  }
  return differences;
}

function catalogHashes(value: unknown): BoundedQualificationReceipt["discovery"]["catalogParity"] | undefined {
  if (
    !isRecord(value) ||
    typeof value.directDescriptorSha256 !== "string" ||
    typeof value.proxiedDescriptorSha256 !== "string"
  ) {
    return undefined;
  }
  return {
    directDescriptorSha256: value.directDescriptorSha256,
    proxiedDescriptorSha256: value.proxiedDescriptorSha256,
    pass: value.pass === true,
  };
}

async function readAdminVersion(
  baseUrl: string,
  adminKey: string,
  fetchFn: typeof fetch | undefined,
): Promise<{ readonly version: string; readonly metadataApiVersion: string }> {
  const client = new HonuaAdminClient({ baseUrl, adminKey, ...(fetchFn ? { fetchFn } : {}) });
  const result = await client.call("getAdminVersion", {});
  const root = result.data as unknown;
  const body = isRecord(root) && isRecord(root.data) ? root.data : isRecord(root) ? root : undefined;
  if (!body || typeof body.version !== "string" || typeof body.metadataApiVersion !== "string") {
    throw new Error("Admin version response did not contain a server identity");
  }
  return { version: body.version, metadataApiVersion: body.metadataApiVersion };
}

async function readMcpConfig(filePath: string): Promise<{ packageArgument?: string; remoteUrl?: string }> {
  try {
    await verifyPrivateFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Refusing to read an unverified MCP client config");
  }
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || !isRecord(parsed.mcpServers.honua)) return {};
  const server = parsed.mcpServers.honua;
  const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === "string") : [];
  const packageFlag = args.indexOf("--package");
  const packageArgument = packageFlag >= 0 ? args[packageFlag + 1] : undefined;
  const env = isRecord(server.env) ? server.env : {};
  const remoteUrl = typeof env.HONUA_MCP_REMOTE_URL === "string" ? env.HONUA_MCP_REMOTE_URL : undefined;
  return {
    ...(packageArgument ? { packageArgument } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}

function structured(result: { readonly structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function readBlob(value: unknown, uri: string): { bytes: Uint8Array; mimeType?: string } {
  if (!isRecord(value) || !Array.isArray(value.contents)) throw new Error(`${uri} returned no resource contents`);
  const content = value.contents.find(
    (candidate): candidate is { blob: string; mimeType?: string } =>
      isRecord(candidate) && typeof candidate.blob === "string",
  );
  if (!content) throw new Error(`${uri} returned no binary blob content`);
  const bytes = new Uint8Array(Buffer.from(content.blob, "base64"));
  if (bytes.length === 0) throw new Error(`${uri} returned an empty blob`);
  return { bytes, ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}) };
}

function parseDigests(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("docker image inspect returned no RepoDigests array");
  }
  return parsed as string[];
}

function normalizeTool(tool: ManifestTool): ManifestTool {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

function scrub(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8 || !text.includes(secret)) return text;
  return text.split(secret).join("[REDACTED]");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
