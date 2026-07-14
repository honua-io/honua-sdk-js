import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createGalleryModel } from "../../scripts/lib/docs-gallery.mjs";
import { validateSiteProjection } from "../../scripts/sample-contract.mjs";

const projection = JSON.parse(fs.readFileSync("samples/dist/honua-site-samples.v2.json", "utf8"));

test("projects one schema-valid catalog-v2 sample into one public gallery card", async () => {
  const oneCard = structuredClone(projection);
  oneCard.samples = [projection.samples.find((sample) => sample.id === "endpoint-to-map")];

  await assert.doesNotReject(validateSiteProjection(oneCard));
  assert.deepEqual(createGalleryModel(oneCard), {
    cardCount: 1,
    groups: [
      {
        track: "recipe",
        title: "Recipes",
        samples: oneCard.samples,
      },
    ],
  });
});

test("refuses to publish a schema-valid projection with zero public cards", async () => {
  const empty = structuredClone(projection);
  empty.samples = [];

  await assert.doesNotReject(validateSiteProjection(empty));
  assert.throws(
    () => createGalleryModel(empty),
    /Gallery projection produced zero public cards; refusing to publish an empty gallery\./,
  );

  const fixtureOnly = structuredClone(projection);
  fixtureOnly.samples = [projection.samples.find((sample) => sample.id === "arcgis-source-app")];
  await assert.doesNotReject(validateSiteProjection(fixtureOnly));
  assert.throws(
    () => createGalleryModel(fixtureOnly),
    /Gallery projection produced zero public cards; refusing to publish an empty gallery\./,
  );
});

test("projects the canonical public portfolio without promoting planned golden journeys", () => {
  const gallery = createGalleryModel(projection);
  const counts = Object.fromEntries(gallery.groups.map((group) => [group.track, group.samples.length]));
  const ids = gallery.groups.flatMap((group) => group.samples.map((sample) => sample.id));

  assert.equal(gallery.cardCount, 32);
  assert.deepEqual(counts, { recipe: 15, lab: 17 });
  assert.ok(!ids.includes("arcgis-source-app"));
  assert.ok(!ids.includes("automatic-source-workflow"));
});
