import process from "node:process";
import { env as importedEnvironment } from "process";
import * as processNamespace from "node:process";

export const defaultImportUrl = process.env.HONUA_DEFAULT_PROCESS_IMPORT_URL;
export const namespaceImportUrl = processNamespace.env.HONUA_NAMESPACE_PROCESS_IMPORT_URL;
export const namedEnvironmentUrl = importedEnvironment.HONUA_NAMED_ENV_IMPORT_URL;
