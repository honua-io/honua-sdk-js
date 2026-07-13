/**
 * `honua geocode "<address>"` — forward geocoding via the SDK geocoding client
 * or, with `--provider`, via a provider-pluggable third-party adapter
 * (Nominatim, Photon, Pelias).
 *
 * @packageDocumentation
 */

import type { GeocodingProvider } from "../../geocoding/index.js";
import { nominatimGeocodingProvider, peliasGeocodingProvider, photonGeocodingProvider } from "../../geocoding/index.js";
import type { ParsedArgs } from "../args.js";
import { getBoolean, getNumber, getString } from "../args.js";
import { createGeocodingClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson, renderTable } from "../output.js";

const DEFAULT_CLI_USER_AGENT = "honua-cli/0.1.0 (+https://github.com/honua-io/honua-sdk-js)";

function createProvider(name: string, parsed: ParsedArgs, ctx: CommandContext): GeocodingProvider {
  const baseUrl = ctx.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `--provider ${name} requires --base-url <url> pointing at an endpoint you are entitled to use; no default third-party endpoint is baked in.`,
    );
  }
  switch (name) {
    case "nominatim":
      return nominatimGeocodingProvider({
        baseUrl,
        userAgent: getString(parsed, "user-agent") ?? DEFAULT_CLI_USER_AGENT,
      });
    case "photon":
      return photonGeocodingProvider({ baseUrl });
    case "pelias":
      return peliasGeocodingProvider({ baseUrl, apiKey: ctx.apiKey });
    default:
      throw new Error(`Unknown geocoding provider "${name}". Supported: honua, nominatim, photon, pelias.`);
  }
}

export async function geocodeCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const address = parsed.positionals.join(" ").trim();
  if (!address) {
    throw new Error('Usage: honua geocode "<address>" [--provider <name>] [--locator <name>] [--limit N]');
  }

  const maxResults = getNumber(parsed, "limit");
  const providerName = getString(parsed, "provider");

  if (providerName !== undefined && providerName !== "honua") {
    const provider = createProvider(providerName, parsed, ctx);
    const results = await provider.geocode(address, maxResults ? { limit: maxResults } : undefined);

    if (getBoolean(parsed, "json")) {
      printLine(renderJson(results));
      return;
    }

    const rows = results.map((r) => ({
      address: r.address,
      lat: r.latitude.toFixed(6),
      lon: r.longitude.toFixed(6),
      score: r.score ?? "",
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
        { title: `Geocode (${provider.id}): "${address}"`, emptyText: "(no candidates)" },
      ),
    );
    printLine(`Attribution: ${provider.attribution}`);
    if (provider.usagePolicyUrl) {
      printLine(`Usage policy: ${provider.usagePolicyUrl}`);
    }
    return;
  }

  const locatorName = getString(parsed, "locator");
  const geo = createGeocodingClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, locatorName });

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
