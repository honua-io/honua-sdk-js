/**
 * Claims `<honua-legend>` for the controls kit's map-style-derived
 * implementation, before `@honua/sdk-js/web-components` (imported after this
 * module in `main.ts`) can auto-register its own controller-driven
 * `honua-legend` and become the tag's canonical/default owner (issue #679;
 * see `@honua/sdk-js/controls`' `catalog.ts`).
 *
 * This lives in its own side-effect module, rather than a plain
 * `defineHonuaLegend()` call in `main.ts`'s body, because ES module `import`
 * declarations are always evaluated before any of the importing module's own
 * top-level statements — a call placed in `main.ts` after its imports would
 * run too late, after `@honua/sdk-js/web-components` had already claimed the
 * tag. Importing this module for its side effect, positioned before the
 * `@honua/sdk-js/web-components` import in `main.ts`, sequences the claim
 * correctly.
 */
import { defineHonuaLegend } from "@honua/sdk-js/controls";

defineHonuaLegend();
