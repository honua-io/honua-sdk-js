import { expect, it } from "vitest";

import {
  ADMIN_OPERATIONS,
  type AdminApiComponents,
  type AdminOperationRequest,
  type AdminOperationResponse,
  HonuaAdminApiError,
  HonuaAdminClient,
} from "../src/control-plane/index.js";

type ObservedRequest = {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: unknown;
};

const SAMPLE_FOLDER: AdminApiComponents["schemas"]["ServiceFolder"] = {
  metadata: { id: "fld-1", name: "utilities", title: "Utilities", tenant: "acme" },
  previousNames: ["legacy-utils"],
  deleted: false,
};

const SAMPLE_PUBLISHED_LAYER: AdminApiComponents["schemas"]["PublishedLayerSummary"] = {
  storageLayerId: 1,
  layerId: 1,
  layerName: "Parcels",
  schema: "public",
  table: "parcels",
  geometryType: "Polygon",
  srid: 4326,
  fieldCount: 5,
  enabled: true,
  serviceName: "parcels",
};

const SAMPLE_SERVICES_PAGE: AdminApiComponents["schemas"]["ServiceListPage"] = {
  items: [
    {
      serviceName: "parcels",
      description: "County parcels",
      layerCount: 2,
      enabledProtocols: ["GeoServices", "OgcApiFeatures"],
      folderId: "fld-1",
      folderName: "utilities",
      publicName: "Parcels",
      title: "County Parcels",
      folderMutationIssues: [],
    },
  ],
  page: 2,
  pageSize: 25,
  total: 31,
  layerTotal: 64,
};

const SAMPLE_LAYERS_PAGE: AdminApiComponents["schemas"]["PublishedLayerPage"] = {
  items: [
    { ...SAMPLE_PUBLISHED_LAYER, storageLayerId: 7, layerId: 7, layerName: "Hydrants", serviceName: "utilities" },
  ],
  page: 1,
  pageSize: 50,
  total: 1,
};

function createRecordingClient(respond: (observed: ObservedRequest) => Response | Promise<Response>): {
  readonly client: HonuaAdminClient;
  readonly requests: ObservedRequest[];
} {
  const requests: ObservedRequest[] = [];
  const client = new HonuaAdminClient({
    baseUrl: "https://example.test",
    adminKey: "admin-key",
    retry: { maxRetries: 0 },
    fetchFn: async (input, init) => {
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const observed: ObservedRequest = {
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: rawBody ? JSON.parse(rawBody) : undefined,
      };
      requests.push(observed);
      return respond(observed);
    },
  });
  return { client, requests };
}

function respondFolderMutation(req: ObservedRequest): Response {
  if (req.method === "POST") {
    return Response.json(
      {
        success: true,
        data: { metadata: { id: "fld/1 a", name: "ops", title: "Operations", tenant: null }, deleted: false },
      },
      { status: 201, headers: { ETag: '"graph-v2"', Location: "/api/v1/admin/folders/fld%2F1%20a" } },
    );
  }
  if (req.method === "PATCH") {
    return Response.json(
      {
        success: true,
        data: { metadata: { id: "fld/1 a", name: "ops-v2", title: null, tenant: null }, deleted: false },
      },
      { status: 200, headers: { ETag: '"graph-v3"' } },
    );
  }
  return new Response(null, { status: 204, headers: { ETag: '"graph-v4"' } });
}

it("exposes all five Folder and Service move operations in ADMIN_OPERATIONS", () => {
  expect(ADMIN_OPERATIONS.listFolders).toMatchObject({ method: "GET", path: "/folders", mutating: false });
  expect(ADMIN_OPERATIONS.createFolder).toMatchObject({ method: "POST", path: "/folders", mutating: true });
  expect(ADMIN_OPERATIONS.updateFolder).toMatchObject({ method: "PATCH", path: "/folders/{id}", mutating: true });
  expect(ADMIN_OPERATIONS.deleteFolder).toMatchObject({ method: "DELETE", path: "/folders/{id}", mutating: true });
  expect(ADMIN_OPERATIONS.moveService).toMatchObject({
    method: "PUT",
    path: "/services/{serviceName}/folder",
    mutating: true,
  });
});

it("lists folders with optional tenant namespace and returns ETag plus typed ServiceFolder entries", async () => {
  const { client, requests } = createRecordingClient(() =>
    Response.json({ success: true, data: [SAMPLE_FOLDER] }, { headers: { ETag: '"graph-v1"' } }),
  );

  const result = await client.call("listFolders", { query: { namespace: "acme.prod" } });

  expect(requests[0]?.method).toBe("GET");
  expect(requests[0]?.url).toBe("https://example.test/api/v1/admin/folders?namespace=acme.prod");
  expect(result.response.headers.get("etag")).toBe('"graph-v1"');
  const folder: AdminApiComponents["schemas"]["ServiceFolder"] | undefined = result.data?.data?.[0];
  expect(folder).toEqual(SAMPLE_FOLDER);
});

it("creates folders with required If-Match, tenant namespace, and ETag/Location headers", async () => {
  const { client, requests } = createRecordingClient(respondFolderMutation);

  const created = await client.call("createFolder", {
    headers: { "If-Match": '"graph-v1"' },
    query: { namespace: "tenant-1" },
    body: { name: "ops", title: "Operations" },
  });

  expect(created.response.status).toBe(201);
  expect(created.response.headers.get("etag")).toBe('"graph-v2"');
  expect(created.response.headers.get("location")).toBe("/api/v1/admin/folders/fld%2F1%20a");
  expect(requests[0]?.url).toBe("https://example.test/api/v1/admin/folders?namespace=tenant-1");
  expect(requests[0]?.headers.get("if-match")).toBe('"graph-v1"');
  expect(requests[0]?.body).toEqual({ name: "ops", title: "Operations" });
});

it("updates and deletes folders with encoded path segments, required If-Match, and ETag headers", async () => {
  const { client, requests } = createRecordingClient(respondFolderMutation);

  const updated = await client.call("updateFolder", {
    path: { id: "fld/1 a" },
    headers: { "If-Match": '"graph-v2"' },
    body: { name: "ops-v2", title: null },
  });
  expect(updated.response.status).toBe(200);
  expect(updated.response.headers.get("etag")).toBe('"graph-v3"');
  expect(requests[0]?.method).toBe("PATCH");
  expect(requests[0]?.url).toBe("https://example.test/api/v1/admin/folders/fld%2F1%20a");
  expect(requests[0]?.headers.get("if-match")).toBe('"graph-v2"');
  expect(requests[0]?.body).toEqual({ name: "ops-v2", title: null });

  const deleted = await client.call("deleteFolder", {
    path: { id: "fld/1 a" },
    headers: { "If-Match": '"graph-v3"' },
    query: { namespace: "tenant-1" },
  });
  expect(deleted.response.status).toBe(204);
  expect(deleted.data).toBeUndefined();
  expect(deleted.response.headers.get("etag")).toBe('"graph-v4"');
  expect(requests[1]?.method).toBe("DELETE");
  expect(requests[1]?.url).toBe("https://example.test/api/v1/admin/folders/fld%2F1%20a?namespace=tenant-1");
  expect(requests[1]?.headers.get("if-match")).toBe('"graph-v3"');
});

it("moves a service into a folder or explicitly back to Root (null folderId) with encoded serviceName", async () => {
  const { client, requests } = createRecordingClient(
    () => new Response(null, { status: 204, headers: { ETag: '"graph-v5"' } }),
  );

  const movedToFolder = await client.call("moveService", {
    path: { serviceName: "city/water main" },
    headers: { "If-Match": '"graph-v4"' },
    query: { namespace: "acme" },
    body: { folderId: "fld-1" },
  });
  expect(movedToFolder.response.status).toBe(204);
  expect(movedToFolder.response.headers.get("etag")).toBe('"graph-v5"');
  expect(requests[0]?.method).toBe("PUT");
  expect(requests[0]?.url).toBe("https://example.test/api/v1/admin/services/city%2Fwater%20main/folder?namespace=acme");
  expect(requests[0]?.headers.get("if-match")).toBe('"graph-v4"');
  expect(requests[0]?.body).toEqual({ folderId: "fld-1" });

  await client.call("moveService", {
    path: { serviceName: "city/water main" },
    headers: { "If-Match": '"graph-v5"' },
    body: { folderId: null },
  });
  expect(requests[1]?.body).toEqual({ folderId: null });
  expect(Object.hasOwn(requests[1]?.body as Record<string, unknown>, "folderId")).toBe(true);
});

it("distinguishes omitted folderId, explicit null Root, and selected folderId on publishLayer", async () => {
  const { client, requests } = createRecordingClient(() =>
    Response.json({ success: true, data: SAMPLE_PUBLISHED_LAYER }, { status: 201 }),
  );
  const basePublish: AdminApiComponents["schemas"]["PublishLayerRequest"] = {
    schema: "public",
    table: "parcels",
    layerName: "Parcels",
    serviceName: "parcels",
  };

  await client.call("publishLayer", { path: { id: "conn-1" }, body: basePublish });
  await client.call("publishLayer", { path: { id: "conn-1" }, body: { ...basePublish, folderId: null } });
  await client.call("publishLayer", {
    path: { id: "conn-1" },
    body: { ...basePublish, folderId: "fld-1", publicName: "ParcelsPublic", namespace: "acme" },
  });

  const omittedPayload = requests[0]?.body as Record<string, unknown>;
  const rootNullPayload = requests[1]?.body as Record<string, unknown>;
  const selectedPayload = requests[2]?.body as Record<string, unknown>;

  expect("folderId" in omittedPayload).toBe(false);
  expect("folderId" in rootNullPayload).toBe(true);
  expect(rootNullPayload.folderId).toBeNull();
  expect(selectedPayload.folderId).toBe("fld-1");
  expect(selectedPayload.publicName).toBe("ParcelsPublic");
  expect(selectedPayload.namespace).toBe("acme");
});

it("preserves HonuaAdminApiError and response details on 409, 412, 428, and 503 folder failures", async () => {
  for (const [status, title] of [
    [409, "Conflict"],
    [412, "Precondition Failed"],
    [428, "Precondition Required"],
    [503, "Service Unavailable"],
  ] as const) {
    const { client } = createRecordingClient(() =>
      Response.json({ title, status, detail: `Folder error ${status}` }, { status }),
    );
    const error = await client
      .call("deleteFolder", { path: { id: "fld-1" }, headers: { "If-Match": '"stale"' } })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(HonuaAdminApiError);
    expect(error).toMatchObject({
      operationId: "deleteFolder",
      statusCode: status,
      body: { title, status, detail: `Folder error ${status}` },
    });
  }
});

it("requires If-Match at compile time for folder mutations and service move", () => {
  const check = (client: HonuaAdminClient): void => {
    // @ts-expect-error createFolder requires headers with If-Match
    void client.call("createFolder", { body: { name: "ops" } });
    // @ts-expect-error updateFolder requires headers with If-Match
    void client.call("updateFolder", { path: { id: "fld-1" }, body: { name: "ops" } });
    // @ts-expect-error deleteFolder requires headers with If-Match
    void client.call("deleteFolder", { path: { id: "fld-1" } });
    // @ts-expect-error moveService requires headers with If-Match
    void client.call("moveService", { path: { serviceName: "svc" }, body: { folderId: null } });

    const validCreate: AdminOperationRequest<"createFolder"> = {
      headers: { "If-Match": '"etag-1"' },
      body: { name: "ops" },
    };
    void validCreate;
  };
  expect(typeof check).toBe("function");
});

it("types listServices as ApiResponseServiceListPage with pagination query params and folder metadata", async () => {
  const { client, requests } = createRecordingClient(() =>
    Response.json(
      { success: true, data: SAMPLE_SERVICES_PAGE, timestamp: "2026-11-27T00:00:00Z" },
      { headers: { ETag: '"graph-v10"' } },
    ),
  );

  const result = await client.call("listServices", {
    query: { page: 2, pageSize: 25, q: "par", folderId: "root" },
  });

  expect(requests[0]?.url).toBe("https://example.test/api/v1/admin/services?page=2&pageSize=25&q=par&folderId=root");
  expect(result.response.headers.get("etag")).toBe('"graph-v10"');

  const page: AdminApiComponents["schemas"]["ServiceListPage"] | undefined = result.data?.data;
  expect(page).toMatchObject({ page: 2, pageSize: 25, total: 31, layerTotal: 64 });
  expect(page?.items[0]).toMatchObject({
    serviceName: "parcels",
    folderId: "fld-1",
    folderName: "utilities",
    publicName: "Parcels",
  });

  const assertNotArray = (response: AdminOperationResponse<"listServices">): void => {
    // @ts-expect-error ServiceListPage is not an array
    const _wrong: readonly AdminApiComponents["schemas"]["ServiceSummary"][] | undefined = response.data;
    void _wrong;
  };
  expect(typeof assertNotArray).toBe("function");
});

it("types getPublishedLayers as ApiResponsePublishedLayerPage with pagination query params", async () => {
  const { client, requests } = createRecordingClient(() =>
    Response.json({ success: true, data: SAMPLE_LAYERS_PAGE, timestamp: "2026-11-27T00:00:00Z" }),
  );

  const result = await client.call("getPublishedLayers", {
    path: { id: "conn/42" },
    query: { serviceName: "utilities", page: 1, pageSize: 50, q: "hyd" },
  });

  expect(requests[0]?.url).toBe(
    "https://example.test/api/v1/admin/connections/conn%2F42/layers?serviceName=utilities&page=1&pageSize=50&q=hyd",
  );

  const page: AdminApiComponents["schemas"]["PublishedLayerPage"] | undefined = result.data?.data;
  expect(page).toMatchObject({ page: 1, pageSize: 50, total: 1 });
  expect(page?.items[0]).toMatchObject({ storageLayerId: 7, layerName: "Hydrants" });

  const assertNotArray = (response: AdminOperationResponse<"getPublishedLayers">): void => {
    // @ts-expect-error PublishedLayerPage is not an array
    const _wrong: readonly AdminApiComponents["schemas"]["PublishedLayerSummary"][] | undefined = response.data;
    void _wrong;
  };
  expect(typeof assertNotArray).toBe("function");
});
