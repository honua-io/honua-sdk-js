/**
 * `honua export` — manage cloud-native Exports (PMTiles + GeoParquet / COG +
 * Portolan STAC collection) through the SDK control-plane client.
 *
 * Supported forms:
 * - `honua export <serviceId/layerId> [--id <exportId>] [--public] [--timeout-ms <ms>] [--dry-run] [--yes] [--json]`
 * - `honua export list [--json]`
 * - `honua export remove <exportId> [--dry-run] [--yes] [--json]`
 *
 * @packageDocumentation
 */

import { createHonuaControlPlane } from "../../control-plane/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getString } from "../args.js";
import { createAdminClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderDetail, renderJson, renderTable } from "../output.js";
import { publicationTimeout, waitForPublicPublication } from "./export-publication.js";
import {
  type ApiResponse,
  type ExportListResponse,
  type ExportRecord,
  type ExportSource,
  unwrapResponse,
} from "./export-response.js";

export const EXPORT_USAGE =
  "Usage:\n" +
  "  honua export <serviceId/layerId> [--id <exportId>] [--public] [--timeout-ms <ms>] [--dry-run] [--yes] [--json]\n" +
  "  honua export list [--json]\n" +
  "  honua export remove <exportId> [--dry-run] [--yes] [--json]";

function sourceLabel(source: ExportSource): string {
  return source.serviceId && source.layerId != null
    ? `${source.serviceId}/${source.layerId}`
    : (source.name ?? source.kind);
}

async function listExports(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createAdminClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const response = unwrapResponse(
    await controlPlane.raw<ApiResponse<ExportListResponse>>({ method: "GET", path: "/exports" }),
  );
  const items = response.items;

  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ items }));
    return;
  }

  const rows = items.map((item) => ({
    id: item.id,
    layer: sourceLabel(item.source),
    version: item.currentVersion ?? "-",
    visibility: item.publicUrl ? "public" : "signed-in",
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
      renderDetail({ exportId, request: `DELETE ${path}`, status: "dry-run" }, { title: "Export unpublish (dry run)" }),
    );
    return;
  }

  if (!getBoolean(parsed, "yes")) {
    throw new ArgError(
      `honua export remove unpublishes export "${exportId}". Re-run with --yes, or preview with --dry-run.`,
    );
  }

  const client = createAdminClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const removed = unwrapResponse(await controlPlane.raw<ApiResponse<ExportRecord>>({ method: "DELETE", path }));
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(removed));
    return;
  }
  printLine(renderDetail({ exportId: removed.id, status: removed.status }, { title: "Export unpublished" }));
}

async function createExport(layer: string, parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const requirePublic = getBoolean(parsed, "public");
  const timeoutMs = requirePublic ? publicationTimeout(parsed) : undefined;

  const source = /^([^/]+)\/(\d+)$/.exec(layer);
  const layerId = Number(source?.[2]);
  if (!source?.[1]?.trim() || !Number.isInteger(layerId) || layerId > 2_147_483_647) {
    throw new ArgError("Specify an export source as <serviceId/layerId>, for example maui-parcels/1.");
  }

  const exportId = getString(parsed, "id");
  const dryRun = getBoolean(parsed, "dry-run");
  const payload = {
    source: { kind: "layer", serviceId: source[1], layerId },
    ...(exportId ? { exportId } : {}),
  };

  if (dryRun) {
    const preview = {
      action: "export.create",
      method: "POST",
      path: "/exports",
      payload,
      ...(requirePublic ? { requirePublic } : {}),
      status: "dry-run",
    };
    if (getBoolean(parsed, "json")) {
      printLine(renderJson(preview));
      return;
    }
    printLine(
      renderDetail(
        {
          layer,
          ...(exportId ? { exportId } : {}),
          request: "POST /exports",
          ...(requirePublic ? { publication: "Require server-confirmed public URL" } : {}),
          status: "dry-run",
        },
        { title: "Export plan (dry run)" },
      ),
    );
    return;
  }

  const client = createAdminClient(ctx);
  const controlPlane = createHonuaControlPlane({ client });
  const created = unwrapResponse(
    await controlPlane.raw<ApiResponse<ExportRecord>>({ method: "POST", path: "/exports", body: payload }),
  );
  const result =
    timeoutMs === undefined ? created : await waitForPublicPublication({ controlPlane, created, timeoutMs });
  printExport(result, parsed);
}

function printExport(created: ExportRecord, parsed: ParsedArgs): void {
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(created));
    return;
  }
  printLine(
    renderDetail(
      {
        id: created.id,
        layer: sourceLabel(created.source),
        ...(created.currentVersion ? { version: created.currentVersion } : {}),
        status: created.status,
        ...(created.collectionUrl ? { collectionUrl: created.collectionUrl } : {}),
        ...(created.publicUrl ? { publicUrl: created.publicUrl } : {}),
        ...(created.jobId ? { jobId: created.jobId } : {}),
        ...(created.notPublicReason ? { notPublicReason: created.notPublicReason } : {}),
      },
      { title: getBoolean(parsed, "public") ? "Export published" : "Export submitted" },
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
