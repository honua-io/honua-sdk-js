/**
 * Safe, bounded discovery for static STAC Catalog, Collection, and Item JSON.
 *
 * Asset formats are derived from explicit media types, roles, STAC extension
 * fields, and bounded byte probes. File-name extensions are never evidence.
 * The surface is opt-in so static-catalog traversal and probe logic do not
 * enter the root SDK bundle.
 *
 * @experimental
 * @module
 */

import { discoverStaticStacRuntime } from "./stac-discovery-runtime.js";

export type {
  DiscoverStaticStacOptions,
  StacAssetCandidate,
  StacAssetClassification,
  StacAssetClassificationEvidence,
  StacAssetClassificationState,
  StacAssetEvidenceCode,
  StacAssetFormat,
  StacCandidateSourceLocator,
  StacDiscoveredDocument,
  StacDiscoveryDiagnostic,
  StacDiscoveryDiagnosticCode,
  StacDiscoveryFetch,
  StacDiscoveryLimits,
  StacDocumentType,
  StacLicense,
  StacJsonObject,
  StacProvider,
  StaticStacDiscoveryResult,
  StaticStacDiscoveryStatistics,
} from "./stac-discovery-types.js";

export { discoverStaticStacRuntime as discoverStaticStac };
