import fixtureJson from "../fixture.json" with { type: "json" };

import type {
  BufferArtifact,
  BufferFeature,
  BufferInputs,
  BufferPoint,
  FixtureExchange,
  PolygonGeometry,
} from "./types.js";

interface PinnedFixtureDocument {
  readonly processId: string;
  readonly jobId: string;
  readonly inputPoint: BufferPoint;
  readonly inputs: BufferInputs;
  readonly resultGeometrySha256: string;
  readonly resultFeature: BufferFeature;
  readonly exchanges: readonly {
    readonly method: string;
    readonly path: string;
    readonly responseStatus: number;
    readonly jobStatus?: string;
  }[];
}

const fixture = fixtureJson as unknown as PinnedFixtureDocument;

export const PROCESS_ID = fixture.processId;
export const JOB_ID = fixture.jobId;
export const INPUT_POINT = fixture.inputPoint;
export const BUFFER_INPUTS = fixture.inputs;
export const RESULT_GEOMETRY_SHA256 = fixture.resultGeometrySha256;
export const RESULT_FEATURE = fixture.resultFeature;
export const PINNED_EXCHANGES = fixture.exchanges;
export const EXECUTION_PATH = `/ogc/processes/processes/${PROCESS_ID}/execution`;
export const JOB_PATH = `/ogc/processes/jobs/${JOB_ID}`;
export const RESULTS_PATH = `${JOB_PATH}/results`;
export const EXECUTION_BODY = { inputs: BUFFER_INPUTS, response: "document" } as const;

export function createResultArtifact(): BufferArtifact {
  return {
    id: "honolulu-hale-buffer-geometry",
    kind: "Inline",
    title: "Honolulu Hale 350 m buffer",
    href: `data:application/geo+json,${encodeURIComponent(JSON.stringify(RESULT_FEATURE))}`,
    type: "application/geo+json",
  };
}

export async function digestGeometry(geometry: PolygonGeometry): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(geometry));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function decodeResultArtifact(value: unknown): BufferFeature {
  if (!value || typeof value !== "object") throw new Error("The OGC result output is not an artifact object.");
  const artifact = value as Partial<BufferArtifact>;
  if (artifact.type !== "application/geo+json" || typeof artifact.href !== "string") {
    throw new Error("The OGC result artifact is not GeoJSON.");
  }
  const comma = artifact.href.indexOf(",");
  if (!artifact.href.startsWith("data:application/geo+json,") || comma < 0) {
    throw new Error("The fixture result must use the server's inline GeoJSON artifact form.");
  }
  const feature = JSON.parse(decodeURIComponent(artifact.href.slice(comma + 1))) as BufferFeature;
  if (feature.type !== "Feature" || feature.geometry?.type !== "Polygon") {
    throw new Error("The GeoJSON result does not contain a polygon feature.");
  }
  return feature;
}

export function createPinnedFixtureFetch(options: { failExecution?: boolean } = {}): {
  readonly fetch: typeof fetch;
  readonly exchanges: FixtureExchange[];
} {
  const exchanges: FixtureExchange[] = [];
  let statusPolls = 0;
  let dismissed = false;

  const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fixtureFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const bodyText = request.method === "POST" ? await request.text() : "";
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    exchanges.push({ method: request.method, path: url.pathname, body, prefer: request.headers.get("prefer") });

    if (request.method === "POST" && url.pathname === EXECUTION_PATH) {
      if (options.failExecution || stableJson(body) !== stableJson(EXECUTION_BODY)) {
        return json(
          { type: "about:blank", title: "Invalid buffer inputs", status: 422, detail: "Invalid buffer inputs: pinned fixture inputs did not match." },
          422,
        );
      }
      statusPolls = 0;
      dismissed = false;
      return json(
        {
          processID: PROCESS_ID,
          jobID: JOB_ID,
          status: "accepted",
          progress: 5,
          message: "Buffer job accepted",
          links: [
            { rel: "status", href: JOB_PATH, type: "application/json" },
            { rel: "results", href: RESULTS_PATH, type: "application/json" },
          ],
        },
        201,
        { location: JOB_PATH },
      );
    }

    if (request.method === "GET" && url.pathname === JOB_PATH) {
      if (dismissed) return json(statusDocument("dismissed", 100, "Buffer job dismissed"));
      statusPolls += 1;
      return statusPolls === 1
        ? json(statusDocument("running", 62, "Computing buffer geometry"))
        : json(statusDocument("successful", 100, "Buffer completed"));
    }

    if (request.method === "GET" && url.pathname === RESULTS_PATH) {
      return json({ output1: createResultArtifact() });
    }

    if (request.method === "DELETE" && url.pathname === JOB_PATH) {
      dismissed = true;
      return json(statusDocument("dismissed", 100, "Dismissed via OGC API"));
    }

    return json({ title: "No such fixture route", status: 404, detail: url.pathname }, 404);
  };

  return { fetch: fixtureFetch as typeof fetch, exchanges };
}

function statusDocument(status: "running" | "successful" | "dismissed", progress: number, message: string) {
  return {
    processID: PROCESS_ID,
    jobID: JOB_ID,
    status,
    progress,
    message,
    links: [
      { rel: "status", href: JOB_PATH, type: "application/json" },
      { rel: "results", href: RESULTS_PATH, type: "application/json" },
    ],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
