/**
 * `honua map export`, `honua map publish`, and `honua tiles` — the map verbs.
 *
 * `map export` calls the MapServer `export` operation via the SDK, then fetches
 * the returned image href and writes the bytes. `tiles` resolves a single XYZ /
 * Esri tile URL (and optionally downloads it).
 *
 * `map publish` is the reference **thin transport adapter** for the shared
 * control-plane command layer (`src/control-plane/commands/`). It parses flags
 * into `MapPackagePublishInput` plus a `HonuaCommandInvocation` and renders the
 * returned receipt — nothing else. Idempotency, `If-Match`, dry run,
 * cancellation, validation, the typed error taxonomy, and receipt assembly all
 * live on the command, so a `honua map publish …` call and the equivalent
 * `runtime.execute(mapPackagePublishCommand, …)` call from MCP, Studio, or
 * plain JS produce the same receipt and the same `auditKey`. Compare with
 * `mapExport` below, which still speaks to the data-plane client directly.
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import type { HonuaCommandInvocation, HonuaCommandReceipt, MapPackagePublishInput } from "../../control-plane/index.js";
import { HonuaCommandError, mapPackagePublishCommand } from "../../control-plane/index.js";
import type { HonuaMapPackage } from "../../runtime/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getString, parseBbox } from "../args.js";
import { createClient, createCommandRuntime } from "../client.js";
import type { CommandContext } from "../command.js";
import { resolveConnection } from "../config.js";
import { downloadCredentialedResource } from "../download.js";
import { printLine, renderDetail, renderJson } from "../output.js";

export async function mapCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
  if (sub === "export") return mapExport(rest, ctx);
  if (sub === "publish") return mapPublish(rest, ctx);
  throw new Error(
    "Usage: honua map export <service>[/<layers>] --bbox ... --size WxH -o out.png\n" +
      "       honua map publish [<mapId>] --package <json|@file> [--message <text>] [--dry-run]",
  );
}

/**
 * Translate `honua map publish` flags into the shared command's input and
 * invocation. Exported so a test can assert that the CLI contributes argument
 * adaptation only — the returned pair is exactly what a direct JS caller would
 * hand to the same command.
 *
 * @internal
 */
export function mapPublishInvocation(parsed: ParsedArgs): {
  readonly input: MapPackagePublishInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const mapId = parsed.positionals[0];
  const packageRaw = getString(parsed, "package");
  if (!packageRaw) {
    throw new ArgError("--package <json|@file> is required, e.g. --package @map-package.json");
  }
  const workspaceId = getString(parsed, "workspace");
  const message = getString(parsed, "message");
  const actor = getString(parsed, "actor");
  const tenantId = getString(parsed, "tenant");
  const idempotencyKey = getString(parsed, "idempotency-key");
  const ifMatch = getString(parsed, "if-match");
  const identity = {
    ...(actor ? { actor } : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  return {
    input: {
      package: readMapPackage(packageRaw),
      ...(mapId ? { mapId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(message ? { message } : {}),
    },
    invocation: {
      transport: "cli",
      ...(Object.keys(identity).length > 0 ? { identity } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(ifMatch ? { ifMatch } : {}),
      ...(getBoolean(parsed, "dry-run") ? { dryRun: true } : {}),
    },
  };
}

async function mapPublish(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = mapPublishInvocation(parsed);
  // Terminal-UX confirmation only, matching `honua admin`'s gate on mutating
  // operations. It decides whether this terminal issues the command; it is not
  // domain sequencing and not an authorization decision, both of which stay in
  // the command layer and on the server respectively.
  if (!invocation.dryRun && !getBoolean(parsed, "yes")) {
    throw new ArgError("honua map publish mutates state. Re-run with --yes, or preview the plan with --dry-run.");
  }
  const runtime = createCommandRuntime({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, profile: ctx.profile });

  let receipt: HonuaCommandReceipt;
  try {
    receipt = await runtime.execute(mapPackagePublishCommand, input, invocation);
  } catch (error) {
    // Adaptation only: the taxonomy is the command layer's, not the CLI's.
    if (error instanceof HonuaCommandError && (error.kind === "validation" || error.kind === "authorization")) {
      throw new ArgError(error.message);
    }
    throw error;
  }

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(receipt));
    return;
  }
  printLine(
    renderDetail(
      {
        command: receipt.commandId,
        status: receipt.status,
        package: receipt.resourceRef?.id ?? "(not assigned)",
        workspace: receipt.resourceRef?.workspaceId ?? "(default)",
        request: `${receipt.plan.method} ${receipt.plan.path}`,
        idempotencyKey: receipt.idempotencyKey,
        correlationId: receipt.correlationId,
        etag: receipt.validators?.etag ?? "(none)",
        authorization: receipt.authorization,
        auditKey: receipt.auditKey,
      },
      { title: receipt.status === "dry-run" ? "Map package publish (dry run)" : "Map package published" },
    ),
  );
}

/** `--package '<json>'` or `--package @file.json`. */
function readMapPackage(value: string): HonuaMapPackage {
  const raw = value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArgError("--package must be JSON or @file containing JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ArgError("--package must be a JSON object (an honua_map_package.v1 document).");
  }
  return parsed as HonuaMapPackage;
}

async function mapExport(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const ref = parsed.positionals[0];
  if (!ref) {
    throw new ArgError("Usage: honua map export <service>[/<layers>] --bbox minx,miny,maxx,maxy --size WxH -o out.png");
  }
  // service ref may be "service" or "service/<layerSpec>" (e.g. "show:1").
  const slash = ref.indexOf("/");
  const service = slash === -1 ? ref : ref.slice(0, slash);
  const layerSpec = slash === -1 ? undefined : ref.slice(slash + 1);

  const bboxRaw = getString(parsed, "bbox");
  if (!bboxRaw) throw new ArgError("--bbox is required, e.g. --bbox -156.7,20.7,-156.3,21.0");
  const bbox = parseBbox(bboxRaw);

  const sizeRaw = getString(parsed, "size") ?? "800x600";
  const sizeParts = sizeRaw.split(/[x,]/).map((n) => Number(n.trim()));
  if (sizeParts.length !== 2 || sizeParts.some((n) => !Number.isFinite(n))) {
    throw new ArgError(`--size must be "WxH", got: ${sizeRaw}`);
  }
  const [width, height] = sizeParts;

  const format = getString(parsed, "format") ?? "png";
  const outPath = getString(parsed, "output");

  const connection = resolveConnection({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const client = createClient(connection);
  const result = await client.exportMap({
    serviceId: service,
    bbox,
    size: [width, height],
    format,
    ...(layerSpec ? { layers: layerSpec } : {}),
    responseFormat: "json",
  });

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(result));
    return;
  }

  if (!result.href) {
    throw new Error("Server returned no image href for the export request.");
  }

  if (outPath) {
    const bytes = await downloadCredentialedResource(result.href, connection);
    fs.writeFileSync(outPath, bytes);
    printLine(
      renderDetail(
        {
          service,
          bbox: bbox.join(","),
          size: `${result.width ?? width}x${result.height ?? height}`,
          format,
          saved: outPath,
          bytes: bytes.length,
        },
        { title: "Map exported" },
      ),
    );
  } else {
    printLine(
      renderDetail(
        {
          service,
          size: `${result.width ?? width}x${result.height ?? height}`,
          format,
          href: result.href,
        },
        { title: "Map export ready (pass -o <file.png> to download)" },
      ),
    );
  }
}

export async function tilesCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const service = parsed.positionals[0];
  const zxy = parsed.positionals[1];
  if (!service || !zxy) {
    throw new ArgError("Usage: honua tiles <service> <z>/<x>/<y> [-o tile.png]");
  }
  const parts = zxy.split("/").map((n) => Number(n.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new ArgError(`Expected "<z>/<x>/<y>" integers, got: ${zxy}`);
  }
  const [z, x, y] = parts;
  const format = (getString(parsed, "format") ?? "png") as "png" | "jpg" | "jpeg" | "tif" | "tiff";

  const connection = resolveConnection({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const client = createClient(connection);
  // Esri tile addressing is level/row/col == z/y/x.
  const url = client.imageService(service).tileUrl(z, y, x, format);

  const outPath = getString(parsed, "output");
  if (outPath) {
    const bytes = await downloadCredentialedResource(url, connection);
    fs.writeFileSync(outPath, bytes);
    printLine(
      renderDetail({ service, tile: `${z}/${x}/${y}`, saved: outPath, bytes: bytes.length }, { title: "Tile saved" }),
    );
    return;
  }

  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ service, z, x, y, url }));
    return;
  }
  printLine(renderDetail({ service, tile: `${z}/${x}/${y}`, url }, { title: "Tile URL" }));
}
