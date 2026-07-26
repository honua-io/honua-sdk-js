/**
 * Tree-shaking regression fixture for the linked-analytics contract (#682).
 *
 * A consumer that accepts artifacts, links them to exploration state, and
 * renders the small accessible default presentation must pay only for that.
 * The measurement proves the core seam never drags in a chart adapter or an
 * optional chart peer: `forbiddenInputs` rejects both
 * `dist/src/analytics/adapters/` and `node_modules/uplot/`, so this fixture
 * fails loudly if the barrel ever re-exports an adapter.
 */
import {
  acceptCategoryArtifact,
  acceptTimeSeriesArtifact,
  bindAnalyticsToExploration,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  createDefaultAnalyticsPresentation,
} from "../../dist/src/analytics/index.js";

export {
  acceptCategoryArtifact,
  acceptTimeSeriesArtifact,
  bindAnalyticsToExploration,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  createDefaultAnalyticsPresentation,
};
