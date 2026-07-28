/**
 * `honua map export <service>/<layer-or-*>` and `honua tiles <service> z/x/y`
 * — visual payoff verbs that render a map image to disk.
 *
 * `map export` calls the MapServer `export` operation via the SDK, then fetches
 * the returned image href and writes the bytes. `tiles` resolves a single XYZ /
 * Esri tile URL (and optionally downloads it).
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getString, parseBbox } from "../args.js";
import { createClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { resolveConnection } from "../config.js";
import { downloadCredentialedResource } from "../download.js";
import { printLine, renderDetail, renderJson } from "../output.js";

export async function mapCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
  if (sub === "export") return mapExport(rest, ctx);
  throw new Error("Usage: honua map export <service>[/<layers>] --bbox ... --size WxH -o out.png");
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
