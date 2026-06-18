/**
 * `honua services` and `honua layers <service>` — catalog/layer browsing.
 *
 * @packageDocumentation
 */

import type { ParsedArgs } from "../args.js";
import { getBoolean } from "../args.js";
import { createClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson, renderTable } from "../output.js";

export async function servicesCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const response = await client.listServices();
  const services = response.services ?? [];

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(response));
    return;
  }

  const rows = services.map((s) => ({ name: s.name, type: s.type }));
  printLine(
    renderTable(
      rows,
      [
        { key: "name", header: "SERVICE" },
        { key: "type", header: "TYPE" },
      ],
      { title: `Services on ${client.serverBaseUrl}`, emptyText: "(no services)" },
    ),
  );
  if (rows.length > 0) printLine(`\n${rows.length} service(s).`);
}

export async function layersCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const serviceId = parsed.positionals[0];
  if (!serviceId) {
    throw new Error("Usage: honua layers <service>");
  }
  const client = createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const service = client.service(serviceId);
  const metadata = await service.featureServiceMetadata();
  const layers = metadata.layers ?? [];
  const tables = metadata.tables ?? [];

  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ layers, tables, serviceDescription: metadata.serviceDescription }));
    return;
  }

  const rows = [
    ...layers.map((l) => ({ id: l.id, name: l.name, kind: "layer" })),
    ...tables.map((t) => ({ id: t.id, name: t.name, kind: "table" })),
  ];
  printLine(
    renderTable(
      rows,
      [
        { key: "id", header: "ID", align: "right" },
        { key: "name", header: "NAME" },
        { key: "kind", header: "KIND" },
      ],
      { title: `Layers in ${serviceId}`, emptyText: "(no layers)" },
    ),
  );
  if (rows.length > 0) {
    printLine(`\nQuery one with:  honua query ${serviceId}/${rows[0].id} --limit 10`);
  }
}
