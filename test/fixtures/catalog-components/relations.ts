export const releasedApp = {
  id: "evacuation",
  kind: "app",
  title: "Evacuation",
  summary: null,
  detailHref: "https://catalog.example/apps/evacuation",
  releasedVersionId: "released-1",
};
export const relationPage = {
  catalogId: "open-data",
  subject: { kind: "service" as const, id: "roads" },
  items: [releasedApp],
  total: 1,
  offset: 0,
  limit: 12,
  facets: {},
  structuredData: {
    "@context": { schema: "https://schema.org/" },
    "@graph": [{ "@id": "https://catalog.example/apps/evacuation", "@type": "schema:WebApplication" }],
  },
};

