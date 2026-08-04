/**
 * Reviewed browser/device capability -> fallback policy for the deck.gl
 * adapter's supported slice (issue #562, REQ-001). Pure and DOM-free so it is
 * unit-testable from Node; the impure fact collection lives in
 * `capability-main.ts`, which runs only in the browser page.
 *
 * Three tiers, in order of preference:
 *  - "supported": deck.gl binary projection renders on this device.
 *  - "fallback-maplibre": deck.gl is not viable, but WebGL2 is present, so the
 *    documented bounded fallback is the MapLibre-only rendering path over the
 *    same query result.
 *  - "unsupported": no WebGL2 context. Neither renderer can draw a map on the
 *    supported lane, so a host surfaces an explicit capability error rather
 *    than a blank canvas.
 *
 * WebGL2 is the floor for *both* renderers, not just deck.gl (#1004): MapLibre
 * GL JS 6 removed WebGL1 support outright, so a WebGL1-only device cannot be
 * handed to the MapLibre fallback either. Classifying it as
 * "fallback-maplibre" would promise a render the current MapLibre major cannot
 * deliver; the honest answer is an explicit capability decision.
 */

export const DECK_GL_CAPABILITY_POLICY = Object.freeze({
  schemaVersion: 2,
  id: "honua-deckgl-browser-capability-v2",
  description:
    "The deck.gl adapter's binary attribute path requires WebGL2 with a texture floor large enough for the " +
    "documented 1M-row scale tier. Below that floor, but still on WebGL2, the bounded fallback is the " +
    "MapLibre-only rendering path; without a WebGL2 context neither renderer can draw on the supported lane " +
    "(MapLibre GL JS 6 requires WebGL2), so callers must receive an explicit capability decision instead of a " +
    "blank canvas.",
  minSupportedMaxTextureSize: 4096,
});

/**
 * @param {{
 *   webgl2: boolean,
 *   webgl1: boolean,
 *   loseContextExtension: boolean,
 *   maxTextureSize: number,
 *   rendererString: string,
 *   deviceMemoryGiB: number | null,
 *   hardwareConcurrency: number,
 * }} facts
 * @returns {{ tier: "supported" | "fallback-maplibre" | "unsupported", reasons: readonly string[] }}
 */
export function classifyDeckGlCapability(facts) {
  if (!facts.webgl2) {
    // No WebGL2: neither the deck.gl binary path nor the MapLibre fallback can
    // render on the supported lane, because MapLibre GL JS 6 dropped WebGL1.
    const detail = facts.webgl1
      ? "Only WebGL1 is available; the deck.gl binary attribute path and MapLibre GL JS 6 both require WebGL2."
      : "No WebGL context (webgl or webgl2) is available on this device.";
    return Object.freeze({ tier: "unsupported", reasons: Object.freeze([detail]) });
  }

  const blockingReasons = [];
  if (facts.maxTextureSize < DECK_GL_CAPABILITY_POLICY.minSupportedMaxTextureSize) {
    blockingReasons.push(
      `MAX_TEXTURE_SIZE ${facts.maxTextureSize} is below the reviewed floor ${DECK_GL_CAPABILITY_POLICY.minSupportedMaxTextureSize}.`,
    );
  }

  const advisoryReasons = [];
  if (!facts.loseContextExtension) {
    advisoryReasons.push("WEBGL_lose_context is unavailable; context-loss recovery cannot be exercised on this device.");
  }

  if (blockingReasons.length > 0) {
    return Object.freeze({ tier: "fallback-maplibre", reasons: Object.freeze([...blockingReasons, ...advisoryReasons]) });
  }
  return Object.freeze({
    tier: "supported",
    reasons: Object.freeze(
      advisoryReasons.length > 0 ? advisoryReasons : ["WebGL2 with a supported MAX_TEXTURE_SIZE."],
    ),
  });
}
