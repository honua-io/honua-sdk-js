import { HonuaClient } from "@honua/sdk-js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaProvider, useDataset, useQuery } from "@honua/sdk-js/react";
import { renderToStaticMarkup } from "react-dom/server";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });

function IncidentCount() {
  const dataset = useDataset({
    id: "ops",
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "incidents",
        protocol: "geoservices-feature-service",
        locator: { url: baseUrl as string, serviceId: "EvalIncidents", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      },
    ],
  });
  const { data } = useQuery(dataset.source("incidents"), { where: "1=1" });
  return <output>{data ? String(data.features.length) : "pending"}</output>;
}

const markup = renderToStaticMarkup(
  <HonuaProvider client={client}>
    <IncidentCount />
  </HonuaProvider>,
);

process.stdout.write(`${JSON.stringify({ markup })}\n`);
