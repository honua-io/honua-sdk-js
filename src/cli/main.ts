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

import { ArgError, getBoolean, getString, parseArgs } from "./args.js";
import type { FlagSpec, ParsedArgs } from "./args.js";
import type { CommandContext, CommandHandler } from "./command.js";
import { adminCommand } from "./commands/admin.js";
import { layersCommand, servicesCommand } from "./commands/catalog.js";
import { connectionCommand, importCommand } from "./commands/control-plane.js";
import { doctorCommand } from "./commands/doctor.js";
import { explainCommand } from "./commands/explain.js";
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
  { name: "admin-key" },
  { name: "profile" },
  { name: "body" },
  { name: "content-type" },
  { name: "path", multiple: true },
  { name: "query", multiple: true },
  { name: "header", multiple: true },
  { name: "secret-output" },
  { name: "directory" },
  { name: "http-port" },
  { name: "locator" },
  { name: "provider" },
  { name: "user-agent" },
  { name: "protocol" },
  { name: "id" },
  { name: "capabilities" },
  { name: "collection" },
  { name: "type-name" },
  { name: "entity-set" },
  { name: "geometry-column" },
  { name: "resolver" },
  { name: "resource-id" },
  { name: "resource-version" },
  { name: "authorization-context" },
  { name: "where" },
  { name: "bbox" },
  { name: "datetime" },
  { name: "collections", multiple: true },
  { name: "fields", multiple: true },
  { name: "format" },
  { name: "size" },
  { name: "output", alias: "o" },
  { name: "limit" },
  { name: "exchange" },
  { name: "replay" },
  { name: "classification" },
  { name: "redaction-acknowledged" },
  { name: "share-with-support" },
  { name: "granted-by" },
  { name: "bundle-id" },
  { name: "preview-bytes" },
  { name: "timeout-ms" },
  { name: "package" },
  { name: "message" },
  { name: "source-kind" },
  { name: "source-url" },
  { name: "connection" },
  { name: "title" },
  { name: "options" },
  { name: "workspace" },
  { name: "actor" },
  { name: "tenant" },
  { name: "if-match" },
  { name: "idempotency-key" },
  { name: "count", boolean: true },
  { name: "json", boolean: true },
  { name: "dry-run", boolean: true },
  { name: "yes", boolean: true },
  { name: "help", alias: "h", boolean: true },
  { name: "version", alias: "V", boolean: true },
];

const COMMANDS: Record<string, CommandHandler> = {
  admin: adminCommand,
  connection: connectionCommand,
  import: importCommand,
  services: servicesCommand,
  layers: layersCommand,
  query: queryCommand,
  explain: explainCommand,
  stac: stacCommand,
  geocode: geocodeCommand,
  map: mapCommand,
  tiles: tilesCommand,
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
  doctor: doctorCommand,
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

  honua explain <ref> [options]               Compile a query into a deterministic execution plan (no server call)
      --protocol <id>      Source protocol (default geoservices-feature-service)
      --where / --bbox / --fields / --limit    Query shape to plan
      --collection / --type-name / --entity-set   Protocol locator for OGC/WFS/OData
      --resource-id / --resolver / --authorization-context   Opaque GeoParquet identity
      --resource-version   Stable GeoParquet data revision (never a credential)
      --json               Emit the full plan (stages, pushdown, compiled request, fingerprint)

STAC
  honua stac collections                      List STAC collections
  honua stac search [options]                 Search STAC items
      --bbox / --datetime / --collections / --limit

GEOCODING
  honua geocode "<address>" [--locator <name>] [--limit N]
      --provider honua|nominatim|photon|pelias   Geocoding provider (default honua)
      --base-url <url>     Provider endpoint (required for third-party providers; no default endpoint is baked in)
      --user-agent <ua>    User-Agent for Nominatim public-instance policy compliance

CONTROL-PLANE COMMANDS (shared command layer; every transport uses these)
  honua connection test <connectionId> [options]
      Probe a stored connection through the shared connection.test command.
      --workspace <id>           Owning workspace, when the deployment scopes them

  honua import create --source-kind <kind> [options]
      Enqueue an import job through the shared import.create command.
      --source-kind <kind>       Import source kind, e.g. geojson or postgis (required)
      --source-url <url>         Source URL, when the import reads a location
      --connection <id>          Stored connection, when the import reads a system
      --workspace <id>           Workspace that will own the imported content
      --title <text>             Human title for the resulting content
      --options <json|@file>     Import-kind-specific options, passed through verbatim

  Both accept the shared command flags below, as honua map publish does:
      --if-match / --idempotency-key / --actor / --tenant / --dry-run / --yes / --json

MAPS
  honua map export <service>[/<layers>] --bbox ... --size WxH [-o out.png]
  honua tiles <service> <z>/<x>/<y> [-o tile.png]

  honua map publish [<mapId>] --package <json|@file> [options]
      Publish a map package through the shared control-plane command layer.
      --package <json|@file>     honua_map_package.v1 document (required)
      --workspace <id>           Owning workspace
      --message <text>           Publication message recorded with the version
      --if-match <etag>          Optimistic-concurrency validator
      --idempotency-key <key>    Explicit key (derived from the input otherwise)
      --actor <id> --tenant <id> Acting identity echoed onto the receipt
      --dry-run                  Print the plan; never contacts the server
      --yes                      Required to actually publish
      --json                     Emit the full command receipt

AUTH / CONFIG
  honua login --base-url <url> [--api-key <key>]
  honua logout
  honua whoami

SUPPORT DIAGNOSTICS
  honua doctor --exchange <capture.json> --classification <value>
      --redaction-acknowledged=true|false --share-with-support=true|false
      --output <bundle.json> [--base-url <public-server>]
  honua doctor --replay <bundle.json> --base-url <server> --output <result.json>
      Emits local schema-validated sanitized evidence. Never uploads. Replay permits only bounded GET/HEAD.

ADMIN CONTROL PLANE
  honua admin <group> <operationId> [options]  Typed admin operation (connect/import/publish/
                                               configure/secure/release/operate)
  honua admin api <operationId> [options]      Complete 396-operation escape hatch
  honua admin operations [group]               List generated operation inventory

GLOBAL OPTIONS
  --base-url <url>     Server base URL (or env HONUA_BASE_URL)
  --api-key <key>      API key (or env HONUA_API_KEY; anonymous if omitted)
  --admin-key <key>    Admin key (or env HONUA_ADMIN_KEY; admin commands only)
  --profile <name>     Named connection profile from the Honua config file
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
    printLine(`Unknown command: ${command}\n`, process.stderr);
    printLine(HELP);
    return 2;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv.slice(1), GLOBAL_FLAGS);
  } catch (err) {
    if (err instanceof ArgError) {
      printLine(`error: ${err.message}`, process.stderr);
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
    adminKey: ctxOverride.adminKey ?? getString(parsed, "admin-key"),
    profile: ctxOverride.profile ?? getString(parsed, "profile"),
  };

  try {
    await handler(parsed, ctx);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (getBoolean(parsed, "json")) {
      printLine(JSON.stringify({ error: message }), process.stderr);
    } else {
      printLine(`error: ${message}`, process.stderr);
    }
    if (err instanceof ArgError) return 2;
    return 1;
  }
}
