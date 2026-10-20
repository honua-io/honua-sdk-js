/**
 * @deprecated Renamed to `@honua/sdk-js/client-compat`, which exports the same
 *   symbols. This subpath re-exports it, warns once per process on first import,
 *   and will be removed in 2026.2. Update imports to `@honua/sdk-js/client-compat`.
 */
import { emitDeprecationNoticeOnce } from "./core/deprecation-notice.js";

const ESRI_COMPAT_SUBPATH_DEPRECATION = {
  code: "HONUA_ESRI_COMPAT_SUBPATH_RENAMED",
  message:
    "@honua/sdk-js/esri-compat is deprecated and will be removed in 2026.2. " +
    "Import from @honua/sdk-js/client-compat instead; it exports the same symbols.",
} as const;

emitDeprecationNoticeOnce(ESRI_COMPAT_SUBPATH_DEPRECATION);

export * from "./client-compat-entry.js";
