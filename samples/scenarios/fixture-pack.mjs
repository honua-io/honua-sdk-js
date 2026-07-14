import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateFixturePackDirectory } from "./fixture-validation.mjs";

const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadFixturePack(id, version = "v1") {
  if (!PACK_ID.test(id) || !/^v[1-9][0-9]*$/.test(version)) throw new Error("Invalid fixture pack id or version.");
  const root = path.join(fixturesRoot, id, version);
  const validated = validateFixturePackDirectory(root);
  return Object.freeze({ id, version, root, manifest: validated.manifest, data: validated.data });
}
