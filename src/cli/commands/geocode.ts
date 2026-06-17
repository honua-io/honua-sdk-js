/**
 * `honua geocode "<address>"` — forward geocoding via the SDK geocoding client.
 *
 * @packageDocumentation
 */

import type { ParsedArgs } from "../args.js";
import { getBoolean, getNumber, getString } from "../args.js";
import { createGeocodingClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson, renderTable } from "../output.js";

export async function geocodeCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const address = parsed.positionals.join(" ").trim();
  if (!address) {
    throw new Error('Usage: honua geocode "<address>" [--locator <name>] [--limit N]');
  }
  const locatorName = getString(parsed, "locator");
  const geo = createGeocodingClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, locatorName });

  const maxResults = getNumber(parsed, "limit");
  const results = await geo.forwardGeocode(address, maxResults ? { maxResults } : undefined);

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(results));
    return;
  }

  const rows = results.map((r) => ({
    address: r.address,
    lat: r.latitude.toFixed(6),
    lon: r.longitude.toFixed(6),
    score: r.score,
  }));
  printLine(
    renderTable(
      rows,
      [
        { key: "address", header: "MATCH" },
        { key: "lat", header: "LAT", align: "right" },
        { key: "lon", header: "LON", align: "right" },
        { key: "score", header: "SCORE", align: "right" },
      ],
      { title: `Geocode: "${address}"`, emptyText: "(no candidates)" },
    ),
  );
}
