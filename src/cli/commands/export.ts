/**
 * `honua export` — manage cloud-native Exports (PMTiles + GeoParquet / COG +
 * Portolan STAC collection) through the SDK control-plane client.
 *
 * Supported forms:
 * - `honua export <layer> [--id <exportId>] [--public] [--dry-run] [--yes] [--json]`
 * - `honua export list [--json]`
 * - `honua export remove <exportId> [--dry-run] [--yes] [--json]`
 *
 * @packageDocumentation
 */

import { createHonuaControlPlane } from "../../control-plane/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getString } from "../args.js";
import { createClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderDetail, renderJson, renderTable } from "../output.js";

export const EXPORT_USAGE =
  "Usage:\n" +
  "  honua export <layer> [--id <exportId>] [--public] [--dry-run] [--yes] [--json]\n" +
  "  honua export list [--json]\n" +
  "  honua export remove <exportId> [--dry-run] [--yes] [--json]";

export interface ExportRecord {
  readonly id: string;
  readonly layer: string;
  readonly version?: string;
  readonly visibility: "public" | "private";
  readonly status: string;
  readonly collectionUrl?: string;
  readonly formats?: readonly string[];
}

interface ExportListResponse {
  readonly items?: readonly ExportRecord[];
  readonly exports?: readonly ExportRecord[];
}

function unwrapResponse<T>(
  result: { readonly supported: true; readonly value: T } | { readonly supported: false; readonly reason: string },
): T {
  if (result.supported) return result.value;
  throw new Error(result.reason);
}

async function listExports(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const response = unwrapResponse(await controlPlane.raw<ExportListResponse>({ method: "GET", path: "/exports" }));
  const items = response?.items ?? response?.exports ?? [];

  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ items }));
    return;
  }

  const rows = items.map((item) => ({
    id: item.id,
    layer: item.layer,
    version: item.version ?? "-",
    visibility: item.visibility,
    status: item.status,
    collectionUrl: item.collectionUrl ?? "-",
  }));
  printLine(
    renderTable(
      rows,
      [
        { key: "id", header: "ID" },
        { key: "layer", header: "LAYER" },
        { key: "version", header: "VERSION" },
        { key: "visibility", header: "VISIBILITY" },
        { key: "status", header: "STATUS" },
        { key: "collectionUrl", header: "COLLECTION" },
      ],
      { title: `Exports on ${client.serverBaseUrl}`, emptyText: "(no exports)" },
    ),
  );
}

async function removeExport(exportId: string | undefined, parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  if (!exportId) throw new ArgError("Usage: honua export remove <exportId> [--dry-run] [--yes] [--json]");
  const dryRun = getBoolean(parsed, "dry-run");
  const path = `/exports/${encodeURIComponent(exportId)}`;

  if (dryRun) {
    const preview = { action: "export.remove", exportId, method: "DELETE", path, status: "dry-run" };
    if (getBoolean(parsed, "json")) {
      printLine(renderJson(preview));
      return;
    }
    printLine(
      renderDetail({ exportId, request: `DELETE ${path}`, status: "dry-run" }, { title: "Export removal (dry run)" }),
    );
    return;
  }

  if (!getBoolean(parsed, "yes")) {
    throw new ArgError(
      `honua export remove deletes export "${exportId}". Re-run with --yes, or preview with --dry-run.`,
    );
  }

  const client = createClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const removed = unwrapResponse(await controlPlane.raw<Record<string, unknown>>({ method: "DELETE", path }));
  const result = { exportId, status: "removed", ...(removed ?? {}) };
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(result));
    return;
  }
  printLine(renderDetail({ exportId, status: "removed" }, { title: "Export removed" }));
}

async function createExport(layer: string, parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const id = getString(parsed, "id");
  const visibility: "public" | "private" = getBoolean(parsed, "public") ? "public" : "private";
  const dryRun = getBoolean(parsed, "dry-run");
  const payload = {
    layer,
    ...(id ? { id } : {}),
    visibility,
    formats: ["pmtiles", "geoparquet"],
  };

  if (dryRun) {
    const preview = { action: "export.create", method: "POST", path: "/exports", payload, status: "dry-run" };
    if (getBoolean(parsed, "json")) {
      printLine(renderJson(preview));
      return;
    }
    printLine(
      renderDetail(
        {
          layer,
          ...(id ? { id } : {}),
          visibility,
          formats: "pmtiles, geoparquet",
          request: "POST /exports",
          status: "dry-run",
        },
        { title: "Export plan (dry run)" },
      ),
    );
    return;
  }

  const client = createClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const created = unwrapResponse(
    await controlPlane.raw<ExportRecord>({ method: "POST", path: "/exports", body: payload }),
  );
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(created));
    return;
  }
  printLine(
    renderDetail(
      {
        id: created.id,
        layer: created.layer,
        ...(created.version ? { version: created.version } : {}),
        visibility: created.visibility,
        status: created.status,
        ...(created.collectionUrl ? { collectionUrl: created.collectionUrl } : {}),
        formats: (created.formats ?? ["pmtiles", "geoparquet"]).join(", "),
      },
      { title: "Export created" },
    ),
  );
}

export async function exportCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  if (!sub) throw new ArgError(EXPORT_USAGE);
  if (sub === "list") {
    await listExports(parsed, ctx);
    return;
  }
  if (sub === "remove") {
    await removeExport(parsed.positionals[1], parsed, ctx);
    return;
  }
  await createExport(sub, parsed, ctx);
}
