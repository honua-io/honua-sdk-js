/**
 * Map pointer claims (issue #1419): lets a component that turns map clicks
 * into its own input — `<honua-measurement>` placing vertices — tell the
 * kit's renderer that those clicks are not feature selections.
 *
 * Without a claim, every vertex click that lands on a feature would also run
 * `controller.selectFeature` and dispatch `honua-selection-change`, silently
 * rewriting the shared selection a table, inspector, or editor is bound to.
 * With one, the renderer still dispatches `honua-map-click` but leaves the
 * shared selection exactly as it was.
 *
 * Claims are keyed by the map object in a `WeakMap`, so a claim never keeps a
 * removed map (or its owner) alive, and releasing is idempotent.
 *
 * @module
 */

const claims = new WeakMap<object, Set<object>>();

/**
 * Claims pointer input on `map` for `owner`. Returns a release function;
 * calling it more than once is a no-op.
 */
export function claimMapPointer(map: object, owner: object): () => void {
  const owners = claims.get(map) ?? new Set<object>();
  owners.add(owner);
  claims.set(map, owners);
  return () => {
    const current = claims.get(map);
    if (!current) return;
    current.delete(owner);
    if (current.size === 0) claims.delete(map);
  };
}

/** Whether any component currently claims pointer input on `map`. */
export function isMapPointerClaimed(map: unknown): boolean {
  if (typeof map !== "object" || map === null) return false;
  return (claims.get(map)?.size ?? 0) > 0;
}
