/**
 * `honua` CLI entry point: a first-class command-line wrapper around
 * `@honua/sdk-js`. Parses global connection flags, dispatches to a subcommand,
 * and maps SDK errors to clean, non-stacktrace exit codes.
 *
 * Reusing the SDK means every verb inherits the same auth, retry, PBF decoding,
 * and error handling as the library — the CLI never speaks raw HTTP.
 *
 * @packageDocumentation
 */

import { ArgError, getString, parseArgs } from "./args.js";
import type { FlagSpec, ParsedArgs } from "./args.js";
import type { CommandContext, CommandHandler } from "./command.js";
import { layersCommand, servicesCommand } from "./commands/catalog.js";
import { geocodeCommand } from "./commands/geocode.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { mapCommand, tilesCommand } from "./commands/map.js";
import { queryCommand } from "./commands/query.js";
import { stacCommand } from "./commands/stac.js";
import { printLine } from "./output.js";

export const CLI_VERSION = "0.1.0";

const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "base-url" },
  { name: "api-key" },
  { name: "locator" },
  { name: "where" },
  { name: "bbox" },
  { name: "datetime" },
  { name: "collections", multiple: true },
  { name: "fields", multiple: true },
  { name: "format" },
  { name: "size" },
  { name: "output", alias: "o" },
  { name: "limit" },
  { name: "count", boolean: true },
  { name: "json", boolean: true },
  { name: "help", alias: "h", boolean: true },
  { name: "version", alias: "V", boolean: true },
];

const COMMANDS: Record<string, CommandHandler> = {
  services: servicesCommand,
  layers: layersCommand,
  query: queryCommand,
  stac: stacCommand,
  geocode: geocodeCommand,
  map: mapCommand,
  tiles: tilesCommand,
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
};

const HELP = `honua — command-line client for Honua geospatial servers (wraps @honua/sdk-js)

USAGE
  honua <command> [options]

CATALOG
  honua services                              List published services
  honua layers <service>                      List layers/tables in a service

DATA
  honua query <service>/<layer> [options]     Query features (the workhorse verb)
      --where <sql>        SQL filter (default 1=1)
      --bbox minx,miny,maxx,maxy   Spatial intersect filter (WGS84)
      --fields <name>      Output field (repeatable; default *)
      --count              Return a feature count only
      --limit N            Max features (default 25)
      --format table|geojson|json  Output shape (default table)

STAC
  honua stac collections                      List STAC collections
  honua stac search [options]                 Search STAC items
      --bbox / --datetime / --collections / --limit

GEOCODING
  honua geocode "<address>" [--locator <name>] [--limit N]

MAPS
  honua map export <service>[/<layers>] --bbox ... --size WxH [-o out.png]
  honua tiles <service> <z>/<x>/<y> [-o tile.png]

AUTH / CONFIG
  honua login --base-url <url> [--api-key <key>]
  honua logout
  honua whoami

GLOBAL OPTIONS
  --base-url <url>     Server base URL (or env HONUA_BASE_URL)
  --api-key <key>      API key (or env HONUA_API_KEY; anonymous if omitted)
  --json               Machine-readable JSON output
  -h, --help           Show help
  -V, --version        Show version

EXAMPLES
  HONUA_BASE_URL=https://demo.honua.io honua services
  honua query maui-parcels/1 --count
  honua query maui-parcels/1 --where "TMK LIKE '2%'" --limit 5
  honua stac collections
`;

/**
 * Run the CLI with a raw argv (everything after `node honua`). Returns an exit
 * code; never calls `process.exit` so it stays testable.
 */
export async function run(argv: ReadonlyArray<string>, ctxOverride: Partial<CommandContext> = {}): Promise<number> {
  const command = argv[0];

  // Top-level help / version (also when no command given).
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printLine(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    printLine(CLI_VERSION);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    printLine(`Unknown command: ${command}\n`);
    printLine(HELP);
    return 2;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv.slice(1), GLOBAL_FLAGS);
  } catch (err) {
    if (err instanceof ArgError) {
      printLine(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (parsed.flags.help === true) {
    printLine(HELP);
    return 0;
  }

  const ctx: CommandContext = {
    baseUrl: ctxOverride.baseUrl ?? getString(parsed, "base-url"),
    apiKey: ctxOverride.apiKey ?? getString(parsed, "api-key"),
  };

  try {
    await handler(parsed, ctx);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printLine(`error: ${message}`, process.stderr);
    if (err instanceof ArgError) return 2;
    return 1;
  }
}
