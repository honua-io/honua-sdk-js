import type { AdapterKind, Source } from "../contract/index.js";

/**
 * A source created by `@honua/sdk-js` or `@honua/sdk`, as this package sees it.
 *
 * Each published package carries its own copy of the contract types. TypeScript
 * compares the typed `protocol()` and `adapter()` results nominally, because
 * they resolve through each copy's own adapter map and adapter classes, so an
 * SDK source is not assignable to this package's `Source`. Every other member
 * is still compared structurally.
 */
export type HonuaSdkSource<T = Record<string, unknown>> = Omit<Source<T>, "protocol" | "adapter"> & {
  protocol(kind: AdapterKind): unknown;
  adapter(kind: AdapterKind): unknown;
};

/**
 * Pass a source created with `@honua/sdk-js` or `@honua/sdk` to an app-platform
 * component or application context.
 *
 * The compiler still checks every member except the typed `protocol()` and
 * `adapter()` results. The function returns the same object; it does not wrap
 * or copy the source, so `protocol()` and `adapter()` still return the SDK's
 * own adapter instances.
 */
export function adoptHonuaSdkSource<T = Record<string, unknown>>(source: HonuaSdkSource<T>): Source<T> {
  return source as Source<T>;
}
