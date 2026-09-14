import { defineConfig } from "vite";

// Explicitly loopback-only. Never put this credential in VITE_* or client code.
// Bind only the run's reviewed FeatureServer routes through HONUA_ALLOWED_SERVICES.
const allowed = (process.env.HONUA_ALLOWED_SERVICES ?? "").split(",").filter(Boolean);
const proxy = Object.fromEntries(
  allowed.map((name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid local service binding");
    return [
      `/rest/services/${name}/FeatureServer`,
      {
        target: "http://127.0.0.1:18615",
        headers: { "X-API-Key": process.env.HONUA_LOCAL_API_KEY ?? "" },
      },
    ];
  }),
);
export default defineConfig({
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
});
