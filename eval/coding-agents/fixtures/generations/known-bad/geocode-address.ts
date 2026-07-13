// Known-bad generation: compiles cleanly but targets a locator that is not
// published on the server, so the request 404s. Must FAIL the runtime stage.
import { HonuaGeocodingClient } from "@honua/sdk-js/geocoding";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const geocoder = new HonuaGeocodingClient({ baseUrl, locatorName: "World" });
const candidates = await geocoder.forwardGeocode("410 Atkinson Dr, Honolulu, HI 96814");

process.stdout.write(
  `${JSON.stringify({
    count: candidates.length,
    address: candidates[0]?.address ?? null,
    score: candidates[0]?.score ?? null,
  })}\n`,
);
