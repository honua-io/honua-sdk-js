import { HonuaClient, createHonuaCacheState } from "@honua/sdk-js/honua";
import type {
  HonuaCacheState,
  HonuaFeature,
  HonuaLayerMetadata,
  HonuaServiceMetadata,
  HonuaServicesResponse,
} from "@honua/sdk-js/honua";

import { shouldUseFixtureData } from "./config.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DIAGNOSTICS,
  FIXTURE_FEATURES,
  FIXTURE_REVALIDATE_AFTER_MS,
  createFixtureServiceExplorerSourceMetadata,
  findFixtureServiceExplorerSourceOption,
} from "./fixtures.js";
import { createServiceExplorerFeatureSummaries } from "./projection.js";
import type {
  ServiceExplorerCapabilitySummary,
  ServiceExplorerCatalog,
  ServiceExplorerConfig,
  ServiceExplorerDataset,
  ServiceExplorerDiagnostic,
  ServiceExplorerLayerSummary,
  ServiceExplorerServiceSummary,
  ServiceExplorerSourceMetadata,
} from "./types.js";

export interface LoadServiceExplorerDatasetOptions {
  readonly fetchFn?: typeof fetch;
  readonly now?: number;
}

export async function loadServiceExplorerDataset(
  config: ServiceExplorerConfig,
  options: LoadServiceExplorerDatasetOptions = {},
): Promise<ServiceExplorerDataset> {
  if (shouldUseFixtureData(config)) {
    return createFixtureServiceExplorerDataset({
      now: options.now,
      sourceOptionId: config.selectedSourceId,
      diagnostics: [
        ...createFixtureServiceExplorerSourceMetadata(findFixtureServiceExplorerSourceOption(config.selectedSourceId))
          .diagnostics,
        {
          level: "info",
          code: "cloud-target",
          title: "Cloud Honua target retained",
          detail: `${config.honuaBaseUrl} ${config.serviceId}/${config.layerId} remains the configured target.`,
        },
      ],
    });
  }

  try {
    return await loadCloudServiceExplorerDataset(config, options);
  } catch (error) {
    if (config.mode === "cloud") throw error;
    const message = error instanceof Error ? error.message : String(error);
    return createFixtureServiceExplorerDataset({
      now: options.now,
      sourceOptionId: config.selectedSourceId,
      diagnostics: [
        ...createFixtureServiceExplorerSourceMetadata(findFixtureServiceExplorerSourceOption(config.selectedSourceId))
          .diagnostics,
        {
          level: "warning",
          code: "cloud-fallback",
          title: "Cloud load fell back to fixtures",
          detail: message,
        },
      ],
    });
  }
}

export function createFixtureServiceExplorerDataset(
  options: {
    readonly now?: number;
    readonly diagnostics?: readonly ServiceExplorerDiagnostic[];
    readonly sourceOptionId?: string;
  } = {},
): ServiceExplorerDataset {
  const now = options.now ?? Date.now();
  const sourceOption = findFixtureServiceExplorerSourceOption(options.sourceOptionId);
  const sourceMetadata = createFixtureServiceExplorerSourceMetadata(sourceOption);
  const diagnostics = options.diagnostics ?? sourceMetadata.diagnostics ?? FIXTURE_DIAGNOSTICS;
  const metadata: ServiceExplorerSourceMetadata = {
    ...sourceMetadata,
    cache: {
      ...sourceMetadata.cache,
      state: {
        ...sourceMetadata.cache.state,
        ageMs: Math.max(0, now - sourceMetadata.cache.updatedAt),
      },
      updatedAt: sourceMetadata.cache.updatedAt || now,
    },
    diagnostics,
  };
  const features = sourceOption.capabilities.table === "supported" ? FIXTURE_FEATURES : [];
  const featureSummaries = createServiceExplorerFeatureSummaries(features, metadata.schema);

  return {
    catalog: FIXTURE_CATALOG,
    sourceId: sourceOption.sourceId,
    sourceOption,
    source: "fixture",
    metadata,
    features,
    featureSummaries,
    diagnostics,
    queryDurationMs: 0,
  };
}

async function loadCloudServiceExplorerDataset(
  config: ServiceExplorerConfig,
  options: LoadServiceExplorerDatasetOptions,
): Promise<ServiceExplorerDataset> {
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const client = new HonuaClient({
    baseUrl: config.honuaBaseUrl,
    apiKey: config.apiKey,
    bearerToken: config.bearerToken,
    fetchFn,
  });
  const diagnostics: ServiceExplorerDiagnostic[] = [];

  const compatibility = await client.checkCompatibility();
  if (!compatibility.supported) {
    diagnostics.push({
      level: "warning",
      code: "compatibility-degraded",
      title: "Compatibility gate degraded",
      detail: compatibility.reasons.join(" "),
    });
  }

  const [servicesResponse, serviceMetadata, layerMetadata] = await Promise.all([
    client.listServices(),
    client.getFeatureServiceMetadata(config.serviceId),
    client.getLayerMetadata(config.serviceId, config.layerId),
  ]);

  const queryStartedAt = Date.now();
  const queryResponse = await client.queryFeatures({
    serviceId: config.serviceId,
    layerId: config.layerId,
    where: config.where,
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    resultRecordCount: config.resultRecordCount,
  });
  const queryDurationMs = Date.now() - queryStartedAt;
  const services = servicesFromResponse(servicesResponse, config.serviceId, serviceMetadata);
  const activeService =
    services.find((service) => service.id === config.serviceId) ??
    createServiceSummary(config.serviceId, "FeatureServer", serviceMetadata);
  const layers = layersFromServiceMetadata(config.serviceId, serviceMetadata, layerMetadata);
  const activeLayer =
    layers.find((layer) => layer.id === config.layerId) ?? createLayerSummary(config.serviceId, layerMetadata);
  const sourceId = activeLayer.sourceId;
  const capabilities = capabilitiesFromLayerMetadata(layerMetadata);

  if (capabilities.statistics !== "supported") {
    diagnostics.push({
      level: "warning",
      code: "statistics-client-side",
      title: "Statistics are client-side",
      detail: "The first slice derives chart buckets from the linked feature query projection.",
      sourceId,
    });
  }
  if (capabilities.attachments === "unsupported") {
    diagnostics.push({
      level: "warning",
      code: "attachments-unsupported",
      title: "Attachments unsupported",
      detail: "The active layer metadata reports supportsAttachments=false.",
      sourceId,
    });
  }

  const metadata: ServiceExplorerSourceMetadata = {
    service: activeService,
    layer: activeLayer,
    schema: layerMetadata,
    serviceMetadata,
    capabilities,
    cache: {
      status: "ready",
      state:
        layerMetadata.cache ??
        serviceMetadata.cache ??
        servicesResponse.cache ??
        createServiceExplorerCacheState(sourceId),
      source: "cloud",
      updatedAt: now,
      revalidateAfterMs: FIXTURE_REVALIDATE_AFTER_MS,
      lastRevalidatedAt: now,
    },
    diagnostics,
  };
  const features = queryResponse.features ?? [];
  const featureSummaries = createServiceExplorerFeatureSummaries(features, layerMetadata);

  return {
    catalog: {
      sources: [
        {
          id: sourceId,
          name: activeLayer.name,
          protocol: "FeatureServer",
          mode: "queryable",
          serviceId: config.serviceId,
          layerId: config.layerId,
          sourceId,
          description: activeService.description ?? "Cloud Honua FeatureServer source.",
          cachePolicy: "Cache service, layer, schema, domains, and capability metadata by service/layer version.",
          capabilities,
        },
      ],
      services,
      layersByServiceId: {
        [config.serviceId]: layers,
      },
    },
    sourceId,
    sourceOption: {
      id: sourceId,
      name: activeLayer.name,
      protocol: "FeatureServer",
      mode: "queryable",
      serviceId: config.serviceId,
      layerId: config.layerId,
      sourceId,
      description: activeService.description ?? "Cloud Honua FeatureServer source.",
      cachePolicy: "Cache service, layer, schema, domains, and capability metadata by service/layer version.",
      capabilities,
    },
    source: "cloud",
    metadata,
    features,
    featureSummaries,
    diagnostics,
    queryDurationMs,
  };
}

function createServiceExplorerCacheState(sourceId: string): HonuaCacheState {
  return createHonuaCacheState({
    scope: "metadata",
    status: "miss",
    keyFingerprint: `metadata:service-explorer:${sourceId}`,
  });
}

function servicesFromResponse(
  response: HonuaServicesResponse,
  selectedServiceId: string,
  selectedServiceMetadata: HonuaServiceMetadata,
): ServiceExplorerServiceSummary[] {
  const services = (response.services ?? []).map((service) =>
    createServiceSummary(
      service.name,
      service.type,
      service.name === selectedServiceId ? selectedServiceMetadata : undefined,
    ),
  );
  if (!services.some((service) => service.id === selectedServiceId)) {
    services.unshift(createServiceSummary(selectedServiceId, "FeatureServer", selectedServiceMetadata));
  }
  return services;
}

function layersFromServiceMetadata(
  serviceId: string,
  serviceMetadata: HonuaServiceMetadata,
  selectedLayerMetadata: HonuaLayerMetadata,
): ServiceExplorerLayerSummary[] {
  const layers: ServiceExplorerLayerSummary[] = (serviceMetadata.layers ?? []).map((layer) => ({
    id: layer.id,
    name: layer.name,
    serviceId,
    serviceType: "FeatureServer",
    sourceId: `${serviceId}:${layer.id}`,
  }));
  if (!layers.some((layer) => layer.id === selectedLayerMetadata.id)) {
    layers.unshift(createLayerSummary(serviceId, selectedLayerMetadata));
  }
  return layers;
}

function createServiceSummary(
  id: string,
  type: string,
  metadata?: HonuaServiceMetadata,
): ServiceExplorerServiceSummary {
  return {
    id,
    name: id.split("/").at(-1) ?? id,
    type,
    layerCount: metadata?.layers?.length,
    description: metadata?.serviceDescription,
    status: type === "FeatureServer" ? "available" : "unsupported",
  };
}

function createLayerSummary(serviceId: string, metadata: HonuaLayerMetadata): ServiceExplorerLayerSummary {
  return {
    id: metadata.id,
    name: metadata.name,
    serviceId,
    serviceType: "FeatureServer",
    geometryType: metadata.geometryType,
    sourceId: `${serviceId}:${metadata.id}`,
  };
}

function capabilitiesFromLayerMetadata(metadata: HonuaLayerMetadata): ServiceExplorerCapabilitySummary {
  return {
    query: "supported",
    render: "supported",
    table: "supported",
    metadata: "supported",
    extent: metadata.extent ? "supported" : "degraded",
    statistics: "degraded",
    attachments: metadata.supportsAttachments ? "supported" : "unsupported",
    find: "degraded",
  };
}
