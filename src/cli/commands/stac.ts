/**
 * `honua stac collections` and `honua stac search` — STAC catalog browsing.
 *
 * @packageDocumentation
 */

import type { StacSearchRequest } from "../../core/types.js";
import type { ParsedArgs } from "../args.js";
import { getArray, getBoolean, getNumber, getString, parseBbox } from "../args.js";
import { createClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson, renderTable } from "../output.js";

export async function stacCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
  switch (sub) {
    case "collections":
      return stacCollections(rest, ctx);
    case "search":
      return stacSearch(rest, ctx);
    default:
      throw new Error("Usage: honua stac <collections|search> [options]");
  }
}

async function stacCollections(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const response = await client.stac().collections();
  const collections = response.collections ?? [];

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(response));
    return;
  }

  const rows = collections.map((c) => ({
    id: c.id,
    title: c.title ?? "",
    description: (c.description ?? "").replace(/\s+/g, " ").slice(0, 60),
  }));
  printLine(
    renderTable(
      rows,
      [
        { key: "id", header: "COLLECTION" },
        { key: "title", header: "TITLE" },
        { key: "description", header: "DESCRIPTION" },
      ],
      { title: `STAC collections on ${client.serverBaseUrl}`, emptyText: "(no collections)" },
    ),
  );
  if (rows.length > 0) printLine(`\n${rows.length} collection(s).`);
}

async function stacSearch(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });

  const request: StacSearchRequest = {};
  const bbox = getString(parsed, "bbox");
  if (bbox) request.bbox = parseBbox(bbox);
  const datetime = getString(parsed, "datetime");
  if (datetime) request.datetime = datetime;
  const collections = getArray(parsed, "collections").flatMap((c) => c.split(","));
  if (collections.length > 0) request.collections = collections;
  request.limit = getNumber(parsed, "limit") ?? 25;

  const response = await client.stac().search(request);
  const items = response.features ?? [];

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(response));
    return;
  }

  const rows = items.map((item) => {
    const props = (item.properties ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? ""),
      collection: item.collection ?? "",
      datetime: String(props.datetime ?? props.start_datetime ?? ""),
      assets: item.assets ? Object.keys(item.assets).length : 0,
    };
  });
  printLine(
    renderTable(
      rows,
      [
        { key: "id", header: "ITEM" },
        { key: "collection", header: "COLLECTION" },
        { key: "datetime", header: "DATETIME" },
        { key: "assets", header: "ASSETS", align: "right" },
      ],
      { title: "STAC search results", emptyText: "(no items matched)" },
    ),
  );
  const matched = response.numberMatched ?? response.context?.matched;
  if (rows.length > 0) {
    printLine(`\n${rows.length} item(s)${matched !== undefined ? ` of ${matched} matched` : ""}.`);
  }
}
