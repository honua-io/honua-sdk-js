import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requiredProcess = require("node:process");
const dynamicallyImportedProcess = (await import("node:process")).default;

export const requiredProcessUrl = requiredProcess.env.HONUA_CJS_TOKEN;
export const dynamicallyImportedProcessUrl = dynamicallyImportedProcess.env.HONUA_DYNAMIC_TOKEN;
