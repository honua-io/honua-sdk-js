import { HonuaCapabilityNotSupportedError } from "@honua/sdk-js";
import type { HonuaClient } from "@honua/sdk-js";
import type { CapabilityAwareSource, Protocol, SourceDescriptor, SourceLocator } from "@honua/sdk-js/contract";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";
import { z } from "zod";

/**
 * PROTOCOL-NEUTRAL source addressing for the MCP tool contract (issue #1005).
 *
 * The tool surface used to address data the way GeoServices does — a required
 * `serviceId` string plus a required numeric `layerId`. That vocabulary is
 * meaningless on OGC API Features, STAC, WFS, and OData, so a "vendor-neutral"
 * server whose only addressing mode is Esri-shaped concedes the claim on
 * inspection.
 *
 * A source is now addressed the way the SDK addresses one: a
 * `SourceDescriptor` (protocol + locator) resolved into a canonical
 * `Source` through `createDataset`. Over the wire that descriptor is carried as
 * one compact string:
 *
 * ```text
 * <protocol>:<address>
 * ```
 *
 * | protocol                        | address form          | example                                |
 * | ------------------------------- | --------------------- | -------------------------------------- |
 * | `geoservices-feature-service`   | `<serviceId>/<layer>` | `geoservices-feature-service:Parks/0`  |
 * | `geoservices-map-service`       | `<serviceId>/<layer>` | `geoservices-map-service:Basemap/2`    |
 * | `ogc-features`                  | `<collectionId>`      | `ogc-features:hotels`                  |
 * | `ogc-records`                   | `<collectionId>`      | `ogc-records:catalog`                  |
 * | `stac`                          | `<collectionId>`      | `stac:sentinel-2-l2a`                  |
 * | `wfs`                           | `<typeName>`          | `wfs:topp:states`                      |
 * | `odata`                         | `<entitySet>`         | `odata:People`                         |
 *
 * `honua_list_sources` emits exactly these strings, so the normal agent flow is
 * discover-then-address with no parsing on the client side. The reference is
 * deliberately fail-closed: an unrecognized protocol token is refused with the
 * accepted forms rather than guessed at, because guessing "which protocol did
 * they mean" is how a neutral surface silently becomes a single-vendor one.
 *
 * The legacy `serviceId` + `layerId` pair is still accepted (see
 * {@link legacyGeoServicesRef}) but is deprecated and is no longer *required* by
 * any schema.
 */

/** Protocols reachable through a `<protocol>:<address>` source reference. */
export const SOURCE_REF_PROTOCOLS = [
  "geoservices-feature-service",
  "geoservices-map-service",
  "ogc-features",
  "ogc-records",
  "stac",
  "wfs",
  "odata",
] as const;

export type SourceRefProtocol = (typeof SOURCE_REF_PROTOCOLS)[number];

/** Short, human-friendly aliases accepted in place of the canonical token. */
const PROTOCOL_ALIASES: Readonly<Record<string, SourceRefProtocol>> = {
  geoservices: "geoservices-feature-service",
  "feature-service": "geoservices-feature-service",
  featureserver: "geoservices-feature-service",
  "map-service": "geoservices-map-service",
  mapserver: "geoservices-map-service",
  ogc: "ogc-features",
  "ogc-api-features": "ogc-features",
  features: "ogc-features",
  records: "ogc-records",
};

/** Endpoint layouts an OGC API / STAC source may be published under. */
export const SOURCE_LAYOUTS = ["honua-facade", "ogc-api", "auto", "stac-api", "stac-static"] as const;

export type SourceLayout = (typeof SOURCE_LAYOUTS)[number];

/** A parsed, validated protocol-neutral source reference. */
export interface ParsedSourceRef {
  /** Canonical `<protocol>:<address>` form (aliases normalized). */
  readonly ref: string;
  readonly protocol: SourceRefProtocol;
  readonly address: string;
  readonly layout?: SourceLayout;
}

export class SourceRefError extends Error {
  readonly code = "INVALID_SOURCE_REFERENCE";

  constructor(message: string) {
    super(message);
    this.name = "SourceRefError";
  }
}

const ACCEPTED_FORMS = SOURCE_REF_PROTOCOLS.map((protocol) => {
  switch (protocol) {
    case "geoservices-feature-service":
    case "geoservices-map-service":
      return `${protocol}:<serviceId>/<layerId>`;
    case "wfs":
      return `${protocol}:<typeName>`;
    case "odata":
      return `${protocol}:<entitySet>`;
    default:
      return `${protocol}:<collectionId>`;
  }
}).join(", ");

function normalizeProtocolToken(token: string): SourceRefProtocol | undefined {
  const normalized = token.trim().toLowerCase();
  if ((SOURCE_REF_PROTOCOLS as readonly string[]).includes(normalized)) {
    return normalized as SourceRefProtocol;
  }
  return PROTOCOL_ALIASES[normalized];
}

/**
 * Parse a `<protocol>:<address>` source reference. Fails closed: an omitted or
 * unrecognized protocol token is refused with the accepted forms instead of
 * being inferred, so a mistyped reference can never silently resolve against
 * the wrong protocol.
 */
export function parseSourceRef(raw: string, layout?: SourceLayout): ParsedSourceRef {
  const value = raw.trim();
  if (value.length === 0) {
    throw new SourceRefError(
      `source must be a non-empty "<protocol>:<address>" reference. Accepted: ${ACCEPTED_FORMS}`,
    );
  }
  const separator = value.indexOf(":");
  if (separator < 0) {
    throw new SourceRefError(
      `source "${raw}" is missing its protocol prefix. Use "<protocol>:<address>" (accepted: ${ACCEPTED_FORMS}), or call honua_list_sources to discover exact source references.`,
    );
  }
  const protocol = normalizeProtocolToken(value.slice(0, separator));
  if (!protocol) {
    throw new SourceRefError(
      `source "${raw}" names an unknown protocol "${value.slice(0, separator)}". Accepted: ${ACCEPTED_FORMS}.`,
    );
  }
  // The address keeps every remaining colon: a WFS typeName is namespace-qualified
  // (`topp:states`) and splitting it again would corrupt the identifier.
  const address = value.slice(separator + 1).trim();
  if (address.length === 0) {
    throw new SourceRefError(`source "${raw}" is missing its address. Accepted: ${ACCEPTED_FORMS}.`);
  }
  return { ref: `${protocol}:${address}`, protocol, address, ...(layout ? { layout } : {}) };
}

/** Build the canonical reference for the deprecated GeoServices `serviceId`/`layerId` pair. */
export function legacyGeoServicesRef(serviceId: string, layerId: number): string {
  return `geoservices-feature-service:${serviceId}/${layerId}`;
}

function splitGeoServicesAddress(ref: ParsedSourceRef): { serviceId: string; layerId: number } {
  const slash = ref.address.lastIndexOf("/");
  if (slash <= 0 || slash === ref.address.length - 1) {
    throw new SourceRefError(
      `source "${ref.ref}" must address a layer as "<serviceId>/<layerId>" (e.g. "${ref.protocol}:Parks/0").`,
    );
  }
  const serviceId = ref.address.slice(0, slash);
  const rawLayer = ref.address.slice(slash + 1);
  if (!/^\d+$/.test(rawLayer)) {
    throw new SourceRefError(`source "${ref.ref}" has a non-numeric layer id "${rawLayer}"; expected a whole number.`);
  }
  return { serviceId, layerId: Number.parseInt(rawLayer, 10) };
}

/** Project a parsed reference onto the SDK's protocol-neutral `SourceLocator`. */
export function toSourceLocator(ref: ParsedSourceRef, baseUrl: string): SourceLocator {
  const layout = ref.layout && ref.layout !== "honua-facade" ? { layout: ref.layout } : {};
  switch (ref.protocol) {
    case "geoservices-feature-service":
    case "geoservices-map-service": {
      const { serviceId, layerId } = splitGeoServicesAddress(ref);
      return { url: baseUrl, serviceId, layerId };
    }
    case "ogc-features":
    case "ogc-records":
    case "stac":
      return { url: baseUrl, collectionId: ref.address, ...layout };
    case "wfs":
      return { url: baseUrl, typeName: ref.address };
    case "odata":
      return { url: baseUrl, entitySet: ref.address };
  }
}

/** Build the `SourceDescriptor` a reference denotes, without contacting the endpoint. */
export function toSourceDescriptor(ref: ParsedSourceRef, baseUrl: string): SourceDescriptor {
  return {
    id: ref.ref,
    protocol: ref.protocol as Protocol,
    locator: toSourceLocator(ref, baseUrl),
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES[ref.protocol as Protocol],
  };
}

/** A resolved source plus the neutral identity it was addressed by. */
export interface ResolvedSource {
  readonly ref: ParsedSourceRef;
  readonly descriptor: SourceDescriptor;
  readonly source: CapabilityAwareSource;
  /** True when the caller used the deprecated `serviceId`/`layerId` pair. */
  readonly legacyAddressing: boolean;
}

/**
 * Zod fields every source-addressed tool mixes into its input schema.
 *
 * `source` is the protocol-neutral reference; `serviceId`/`layerId` remain as
 * OPTIONAL, deprecated compatibility inputs so existing MCP clients keep
 * working. No Esri-only field is required by any tool schema.
 */
export const sourceRefFields = {
  source: z
    .string()
    .optional()
    .describe(
      'Protocol-neutral source reference "<protocol>:<address>" as emitted by honua_list_sources — e.g. "ogc-features:hotels", "stac:sentinel-2-l2a", "wfs:topp:states", "odata:People", "geoservices-feature-service:Parks/0". Preferred over the deprecated serviceId/layerId pair.',
    ),
  layout: z
    .enum(SOURCE_LAYOUTS)
    .optional()
    .describe(
      'Endpoint layout for OGC API / STAC sources: "honua-facade" (default, Honua server paths), "ogc-api"/"auto" (third-party OGC API root), "stac-api"/"stac-static" (STAC). Ignored by other protocols.',
    ),
  serviceId: z
    .string()
    .optional()
    .describe(
      "[DEPRECATED — use `source`] GeoServices service id. Only meaningful on an Esri FeatureServer/MapServer.",
    ),
  layerId: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("[DEPRECATED — use `source`] GeoServices layer id within the service. Required with `serviceId`."),
} as const;

export type SourceRefInput = {
  source?: string | undefined;
  layout?: SourceLayout | undefined;
  serviceId?: string | undefined;
  layerId?: number | undefined;
};

/** Resolve the neutral reference an input addresses (without building a `Source`). */
export function resolveSourceRef(input: SourceRefInput): { ref: ParsedSourceRef; legacyAddressing: boolean } {
  if (input.source !== undefined && input.source.trim().length > 0) {
    return { ref: parseSourceRef(input.source, input.layout), legacyAddressing: false };
  }
  if (input.serviceId !== undefined && input.serviceId.trim().length > 0) {
    if (input.layerId === undefined) {
      throw new SourceRefError(
        `serviceId "${input.serviceId}" was given without layerId. Pass both, or (preferred) a protocol-neutral \`source\` reference such as "geoservices-feature-service:${input.serviceId}/0".`,
      );
    }
    return {
      ref: parseSourceRef(legacyGeoServicesRef(input.serviceId, input.layerId), input.layout),
      legacyAddressing: true,
    };
  }
  if (input.layerId !== undefined) {
    throw new SourceRefError(
      "layerId was given without serviceId. Pass both, or (preferred) a protocol-neutral `source` reference.",
    );
  }
  throw new SourceRefError(
    `no source was addressed. Pass \`source\` as "<protocol>:<address>" (accepted: ${ACCEPTED_FORMS}); call honua_list_sources to discover the exact references this endpoint serves.`,
  );
}

/**
 * Resolve an input onto a canonical `Source`.
 *
 * The dataset runs under the `degraded` capability policy so a protocol that
 * cannot serve a request first-party (OGC API Features has no server-side
 * aggregation, for example) answers with an explicit `Result.degraded` reason
 * instead of failing outright. Capabilities the protocol cannot serve at all
 * still throw `HonuaCapabilityNotSupportedError`, which the tool layer turns
 * into a structured tool error — never a silent empty result.
 */
export function resolveSource(client: HonuaClient, input: SourceRefInput): ResolvedSource {
  const { ref, legacyAddressing } = resolveSourceRef(input);
  const descriptor = toSourceDescriptor(ref, client.serverBaseUrl);
  const dataset = createDataset({
    id: `honua-mcp:${ref.ref}`,
    client,
    sources: [descriptor],
    capabilityPolicy: "degraded",
    // The standalone server points at arbitrary public endpoints; a Honua
    // server-version handshake is neither available nor meaningful there.
    skipCompatibilityCheck: true,
  });
  let source: CapabilityAwareSource | undefined;
  try {
    source = dataset.source(descriptor.id);
  } catch (error) {
    // A capability refusal is the SDK's own honest signal and travels as-is.
    // Anything else (an incomplete locator, a runtime that cannot construct the
    // protocol adapter) becomes an actionable addressing error rather than an
    // opaque stack trace.
    if (error instanceof HonuaCapabilityNotSupportedError) {
      throw error;
    }
    throw new SourceRefError(
      `source "${ref.ref}" could not be resolved to a runtime adapter: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!source) {
    throw new SourceRefError(`source "${ref.ref}" could not be resolved to a runtime adapter.`);
  }
  return { ref, descriptor, source, legacyAddressing };
}

/** True when a resolved source speaks a GeoServices (Esri) protocol. */
export function isGeoServicesProtocol(protocol: string): boolean {
  return protocol.startsWith("geoservices-") || protocol === "grpc";
}

/**
 * Resolve the OGC API Features endpoint layout a metadata call must use.
 *
 * `honua-facade` (the default) needs no resolution; a third-party OGC API root
 * is discovered from its landing page once and cached on the client. STAC
 * layouts are not OGC API Features layouts and resolve to `undefined`.
 */
export function ogcLayoutFor(client: HonuaClient, layout: SourceLayout | undefined) {
  if (layout === "ogc-api" || layout === "auto") {
    return client.resolveOgcFeaturesLayout(layout);
  }
  return Promise.resolve(undefined);
}
