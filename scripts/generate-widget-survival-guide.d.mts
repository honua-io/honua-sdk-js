import type {
  WidgetDisposition,
  WidgetDispositionKind,
} from "../src/migration/widget-dispositions.js";

export interface WidgetSurvivalGuideData {
  WIDGET_DISPOSITIONS: readonly WidgetDisposition[];
  WIDGET_DISPOSITION_KINDS: readonly WidgetDispositionKind[];
  WIDGET_DISPOSITION_DATA_VERSION: string;
  ARCGIS_WIDGET_DEPRECATION_RELEASE: string;
  ARCGIS_WIDGET_REMOVAL_RELEASE: string;
  ARCGIS_WIDGET_REMOVAL_TIMEFRAME: string;
  ARCGIS_WIDGET_INVENTORY_SOURCE: string;
  widgetSurvivalGuideAnchor(widget: string): string;
}

export function generateWidgetSurvivalGuideMarkdown(data: WidgetSurvivalGuideData): string;
export function validateGuideLinks(markdown: string, sourcePath: string, projectRoot?: string): void;
