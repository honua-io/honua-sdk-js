/**
 * Reviewed browser/device capability -> fallback policy for the deck.gl
 * adapter's supported slice (issue #562, REQ-001). Pure and DOM-free so it is
 * unit-testable from Node; the impure fact collection lives in
 * `capability-main.ts`, which runs only in the browser page.
 *
 * Three tiers, in order of preference:
 *  - "supported": deck.gl binary projection renders on this device.
 *  - "fallback-maplibre": deck.gl is not viable; the documented bounded
 *    fallback is the MapLibre-only rendering path over the same query result.
 *  - "unsupported": no WebGL context at all. Neither renderer can draw a
 *    map; a host surfaces an explicit capability error rather than a blank
 *    canvas.
 */

export const DECK_GL_CAPABILITY_POLICY = Object.freeze({
  schemaVersion: 1,
  id: "honua-deckgl-browser-capability-v1",
  description:
    "The deck.gl adapter's binary attribute path requires WebGL2 with a texture floor large enough for the " +
    "documented 1M-row scale tier. Below that floor the bounded fallback is the MapLibre-only rendering path; " +
    "with no WebGL context at all, callers must receive an explicit capability decision instead of a blank canvas.",
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
  if (!facts.webgl1 && !facts.webgl2) {
    return Object.freeze({
      tier: "unsupported",
      reasons: Object.freeze(["No WebGL context (webgl or webgl2) is available on this device."]),
    });
  }

  const blockingReasons = [];
  if (!facts.webgl2) {
    blockingReasons.push("WebGL2 is unavailable; the adapter's zero-copy binary attribute path requires WebGL2.");
  } else if (facts.maxTextureSize < DECK_GL_CAPABILITY_POLICY.minSupportedMaxTextureSize) {
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
