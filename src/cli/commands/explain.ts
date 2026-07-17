/**
 * `honua explain <ref>` — compile a protocol-neutral query into a deterministic
 * execution plan and print it, without contacting a server.
 *
 * This is a first-class *plan consumer*: it builds a `SourceDescriptor` from CLI
 * flags and calls `explainQuery` from `@honua/sdk-js/query-planner`, then renders
 * the resulting stages, pushdown, per-protocol compiled request, fidelity, plan
 * fingerprint, and warnings. Planning is side-effect free, so `honua explain`
 * needs no live endpoint and no credentials — it reasons about the query the
 * same way the executor and renderers do.
 *
 * @packageDocumentation
 */

import type { Capability, Protocol, Query, SourceDescriptor, SourceLocator } from "../../contract/types.js";
import { PROTOCOLS, PROTOCOL_DEFAULT_CAPABILITIES, capabilities } from "../../contract/types.js";
import { createGeoParquetResourceHandle, explainQuery } from "../../query-planner/index.js";
import type { GeoParquetResourceHandleV1 } from "../../query-planner/resource.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getArray, getBoolean, getNumber, getString, parseBbox, parseServiceLayer } from "../args.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson } from "../output.js";

function parseProtocol(raw: string | undefined): Protocol {
  if (raw === undefined) return "geoservices-feature-service";
  if (!PROTOCOLS.includes(raw as Protocol)) {
    throw new ArgError(`Unknown --protocol "${raw}". One of: ${PROTOCOLS.join(", ")}`);
  }
  return raw as Protocol;
}

function parseCapabilities(raw: string | undefined, protocol: Protocol): Capability[] {
  if (raw === undefined) return [...PROTOCOL_DEFAULT_CAPABILITIES[protocol]];
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as Capability[];
}

/**
 * Resolve the protocol-specific locator from the positional ref and flags. The
 * ref carries `<service>/<layer>` for GeoServices/gRPC, the collection id for
 * OGC API Features, the type name for WFS, the entity set for OData, and the
 * opaque resource id for GeoParquet.
 */
function buildLocator(protocol: Protocol, ref: string | undefined, baseUrl: string, parsed: ParsedArgs): SourceLocator {
  switch (protocol) {
    case "geoservices-feature-service":
    case "grpc": {
      if (!ref) throw new ArgError(`Usage: honua explain <service>/<layer> --protocol ${protocol}`);
      const { service, layer } = parseServiceLayer(ref);
      return { url: baseUrl, serviceId: service, layerId: layer };
    }
    case "ogc-features":
      return { url: baseUrl, collectionId: ref ?? getString(parsed, "collection") ?? mustFlag("collection") };
    case "wfs":
      return { url: baseUrl, typeName: ref ?? getString(parsed, "type-name") ?? mustFlag("type-name") };
    case "odata":
      return { url: baseUrl, entitySet: ref ?? getString(parsed, "entity-set") ?? mustFlag("entity-set") };
    case "geoparquet": {
      const geometryColumn = getString(parsed, "geometry-column");
      return {
        url: "honua-resource://opaque",
        ...(geometryColumn ? { geoparquet: { geometryColumn } } : {}),
      };
    }
    default:
      return { url: baseUrl };
  }
}

function buildGeoParquetResource(parsed: ParsedArgs, ref: string | undefined): GeoParquetResourceHandleV1 {
  try {
    return createGeoParquetResourceHandle({
      resolver: getString(parsed, "resolver") ?? "io.honua.cli",
      id: getString(parsed, "resource-id") ?? ref ?? mustFlag("resource-id"),
      authorizationContextId: getString(parsed, "authorization-context") ?? "anonymous",
      ...(getString(parsed, "resource-version") ? { resourceVersion: getString(parsed, "resource-version") } : {}),
    });
  } catch {
    throw new ArgError(
      "GeoParquet explain requires a bounded opaque resource id, resolver, and non-secret authorization context",
    );
  }
}

function mustFlag(name: string): never {
  throw new ArgError(`--protocol requires a --${name} value (or pass it as the positional argument)`);
}

function buildQuery(parsed: ParsedArgs): Query {
  const where = getString(parsed, "where");
  const fields = getArray(parsed, "fields");
  const limit = getNumber(parsed, "limit");
  const bboxRaw = getString(parsed, "bbox");
  const query: Query = {
    ...(where ? { where } : {}),
    ...(fields.length > 0 ? { outFields: fields } : {}),
    ...(limit !== undefined ? { pagination: { limit } } : {}),
  };
  if (bboxRaw) {
    const [xmin, ymin, xmax, ymax] = parseBbox(bboxRaw);
    query.spatialFilter = {
      geometry: { xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
    };
  }
  return query;
}

export async function explainCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const protocol = parseProtocol(getString(parsed, "protocol"));
  const baseUrl = ctx.baseUrl ?? "https://example.invalid";
  const ref = parsed.positionals[0];
  const locator = buildLocator(protocol, ref, baseUrl, parsed);

  const descriptor: SourceDescriptor = {
    id:
      getString(parsed, "id") ??
      (protocol === "geoparquet" ? (getString(parsed, "resource-id") ?? ref) : ref) ??
      protocol,
    protocol,
    locator,
    capabilities: capabilities(parseCapabilities(getString(parsed, "capabilities"), protocol)),
  };

  const query = buildQuery(parsed);
  const plan =
    protocol === "geoparquet"
      ? explainQuery({ descriptor, query, geoparquetResource: buildGeoParquetResource(parsed, ref) })
      : explainQuery({ descriptor, query });

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(plan));
    return;
  }

  printLine(`Plan ${plan.id}  (${plan.pushdown} pushdown, fidelity ${plan.fidelity}, cache ${plan.cache.action})`);
  printLine(`Source: ${descriptor.id} [${protocol}]`);
  for (const step of plan.steps) {
    const op = "operation" in step ? step.operation : "aggregate";
    printLine(`\n  ${step.id}  ${step.engine}/${op}  pushdown=${step.pushdown}  fidelity=${step.fidelity}`);
    printLine(`    ${step.reason}`);
    if (step.engine === "remote") {
      printLine(`    compiled: ${step.compiled.compiler}`);
      printLine(indentJson(step.compiled, 6));
    }
  }
  if (plan.warnings.length > 0) {
    printLine("\n  warnings:");
    for (const warning of plan.warnings) {
      printLine(`    - [${warning.code}] ${warning.message} (${warning.path})`);
      printLine(`      remediation: ${warning.remediation}`);
    }
  }
  printLine(`\n  fingerprint: ${plan.fingerprint}`);
}

function indentJson(value: unknown, spaces: number): string {
  const pad = " ".repeat(spaces);
  return renderJson(value)
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}
