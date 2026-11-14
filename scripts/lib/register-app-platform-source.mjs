// Node counterpart of the `@honua/app-platform/*` aliases in vitest.config.ts and
// tsconfig.json: compiled in-repo code (dist/bench, dist/examples) imports the
// app-platform surfaces, which this repository builds rather than installs.
import { register } from "node:module";

register("./app-platform-source-resolver.mjs", import.meta.url);
