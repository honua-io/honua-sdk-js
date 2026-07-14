const process = {
  env: { HONUA_SHADOWED_PROCESS_URL: "local process value" },
};
const globalThis = {
  process: { env: { HONUA_SHADOWED_GLOBAL_THIS_URL: "local global value" } },
};
const global = {
  process: { env: { HONUA_SHADOWED_GLOBAL_URL: "local Node global value" } },
};

export const localProcessUrl = process.env.HONUA_SHADOWED_PROCESS_URL;
export const localGlobalThisUrl = globalThis.process.env.HONUA_SHADOWED_GLOBAL_THIS_URL;
export const localGlobalUrl = global.process.env.HONUA_SHADOWED_GLOBAL_URL;
