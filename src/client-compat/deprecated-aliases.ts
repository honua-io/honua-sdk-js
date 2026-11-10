// @honua/honua-migrate@0.3.0-beta.0 imports these names from this subpath.
import { clientConfig, getClientConfigHonuaInterceptors, resetClientConfig } from "./client-config.js";
import { clientRequest } from "./client-request.js";

/** @deprecated Use `clientConfig`. Removed in 0.4.0. */
export const esriConfig = clientConfig;

/** @deprecated Use `clientRequest`. Removed in 0.4.0. */
export const esriRequest = clientRequest;

/** @deprecated Use `resetClientConfig`. Removed in 0.4.0. */
export const resetEsriConfig = resetClientConfig;

/** @deprecated Use `getClientConfigHonuaInterceptors`. Removed in 0.4.0. */
export const getEsriConfigHonuaInterceptors = getClientConfigHonuaInterceptors;
