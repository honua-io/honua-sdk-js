/**
 * Converts Esri popupInfo to Honua popup configuration.
 *
 * Since MapLibre has no popup specification, popup configuration is
 * stored outside the style as metadata.
 *
 * @module
 */

import type { WebMapFieldInfo, WebMapMediaInfo, WebMapPopupInfo } from "./types.js";
import { type WarningCollector, warnUnknownProperties } from "./warnings.js";

export interface HonuaPopupFieldInfo {
  fieldName: string;
  label?: string;
  visible: boolean;
  format?: {
    places?: number;
    digitSeparator?: boolean;
    dateFormat?: string;
  };
}

export interface HonuaPopupMediaInfo {
  type: string;
  title?: string;
  caption?: string;
  value?: Record<string, unknown>;
}

export interface HonuaPopupConfig {
  title?: string;
  description?: string;
  fieldInfos: HonuaPopupFieldInfo[];
  mediaInfos: HonuaPopupMediaInfo[];
}

export function convertPopupInfo(
  popupInfo: WebMapPopupInfo | undefined,
  warn?: WarningCollector,
): HonuaPopupConfig | undefined {
  if (!popupInfo) return undefined;

  if (warn) {
    warnUnknownProperties(popupInfo, POPUP_INFO_PROPERTIES, warn);
    const expressionInfos = (popupInfo as { expressionInfos?: unknown }).expressionInfos;
    if (Array.isArray(expressionInfos) && expressionInfos.length > 0) {
      warn.warn(
        "unsupported-arcade-expression",
        "popupInfo.expressionInfos is not supported; Arcade expressions require manual intervention",
        { count: expressionInfos.length },
      );
    }
  }

  return {
    title: popupInfo.title,
    description: popupInfo.description,
    fieldInfos: (popupInfo.fieldInfos ?? []).map((fieldInfo, index) =>
      convertFieldInfo(fieldInfo, warn?.child(`fieldInfos[${index}]`)),
    ),
    mediaInfos: (popupInfo.mediaInfos ?? []).map((mediaInfo, index) =>
      convertMediaInfo(mediaInfo, warn?.child(`mediaInfos[${index}]`)),
    ),
  };
}

function convertFieldInfo(info: WebMapFieldInfo, warn?: WarningCollector): HonuaPopupFieldInfo {
  if (warn) {
    warnUnknownProperties(info, POPUP_FIELD_INFO_PROPERTIES, warn);
    warnUnknownProperties(
      info.format as Record<string, unknown> | undefined,
      POPUP_FIELD_FORMAT_PROPERTIES,
      warn.child("format"),
    );
  }

  return {
    fieldName: info.fieldName ?? "",
    label: info.label,
    visible: info.visible !== false,
    ...(info.format
      ? {
          format: {
            ...(info.format.places != null ? { places: info.format.places } : {}),
            ...(info.format.digitSeparator != null ? { digitSeparator: info.format.digitSeparator } : {}),
            ...(info.format.dateFormat ? { dateFormat: info.format.dateFormat } : {}),
          },
        }
      : {}),
  };
}

function convertMediaInfo(info: WebMapMediaInfo, warn?: WarningCollector): HonuaPopupMediaInfo {
  if (warn) {
    warnUnknownProperties(info, POPUP_MEDIA_INFO_PROPERTIES, warn);
  }

  return {
    type: info.type ?? "unknown",
    ...(info.title ? { title: info.title } : {}),
    ...(info.caption ? { caption: info.caption } : {}),
    ...(info.value ? { value: info.value } : {}),
  };
}

const POPUP_INFO_PROPERTIES = [
  "title",
  "description",
  "fieldInfos",
  "mediaInfos",
  "showAttachments",
  "expressionInfos",
] as const;

const POPUP_FIELD_INFO_PROPERTIES = ["fieldName", "label", "tooltip", "visible", "isEditable", "format"] as const;

const POPUP_FIELD_FORMAT_PROPERTIES = ["places", "digitSeparator", "dateFormat"] as const;

const POPUP_MEDIA_INFO_PROPERTIES = ["type", "title", "caption", "value"] as const;
