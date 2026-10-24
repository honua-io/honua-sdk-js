/** Read only the mounted starter's actual rendered-data observation. */
export function readMapObservation() {
  const map = document.querySelector('[data-honua-map-state="mounted"]');
  const value = map?.getAttribute("data-honua-rendered-features") ?? "";
  const count = /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : 0;
  return {
    mapMounted: map !== null,
    canvasPresent: document.querySelector(".maplibregl-canvas") !== null,
    renderedFeatureCount: Number.isSafeInteger(count) ? count : 0,
  };
}

export async function probeFirstMap(url, journey, { timeoutMs = 45_000, launch } = {}) {
  const browser = launch ? await launch() : await (await import("playwright")).chromium.launch();
  let page;
  try {
    page = await browser.newPage();
    const origin = new URL(url).origin;
    page.on("console", (message) => {
      if (message.type() === "error") journey.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => journey.consoleErrors.push(error.message));
    page.on("request", (request) => {
      const value = request.url();
      if (value.startsWith("data:")) return;
      try {
        if (new URL(value).origin === origin) return;
      } catch { /* Invalid URLs cannot establish the required origin. */ }
      journey.externalRequests.push(value);
    });
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForSelector(".maplibregl-canvas", { timeout: timeoutMs });
    journey.canvasPresent = true;
    await page.waitForFunction(() => {
      const map = document.querySelector('[data-honua-map-state="mounted"]');
      const value = map?.getAttribute("data-honua-rendered-features") ?? "";
      return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
    }, undefined, { timeout: timeoutMs });
    Object.assign(journey, await page.evaluate(readMapObservation));
    if (!journey.mapMounted || !journey.canvasPresent || journey.renderedFeatureCount <= 0) {
      throw new Error("The starter has no observed rendered data features.");
    }
    return journey;
  } finally {
    if (page) {
      try { Object.assign(journey, await page.evaluate(readMapObservation)); }
      catch { /* Preserve earlier observations when the page is no longer readable. */ }
    }
    await browser.close();
  }
}
