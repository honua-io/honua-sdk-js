const adoptedSheets = new WeakMap<object, CSSStyleSheet>();

function splitStyleBlocks(html: string): { markup: string; styles: string[] } {
  const lower = html.toLowerCase();
  const styles: string[] = [];
  let markup = "";
  let cursor = 0;

  while (cursor < html.length) {
    let open = lower.indexOf("<style", cursor);
    while (open >= 0) {
      const next = html.charCodeAt(open + 6);
      if (next === 62 || next === 47 || next === 9 || next === 10 || next === 12 || next === 13 || next === 32) break;
      open = lower.indexOf("<style", open + 6);
    }
    if (open < 0) {
      markup += html.slice(cursor);
      break;
    }

    const openEnd = html.indexOf(">", open + 6);
    const close = openEnd < 0 ? -1 : lower.indexOf("</style>", openEnd + 1);
    if (openEnd < 0 || close < 0) {
      markup += html.slice(cursor);
      break;
    }

    markup += html.slice(cursor, open);
    styles.push(html.slice(openEnd + 1, close));
    cursor = close + 8;
  }

  return { markup, styles };
}

/**
 * Moves static `<style>` blocks into a constructable stylesheet when the DOM
 * supports it. The inline fallback preserves headless/jsdom compatibility.
 */
export function renderCspSafeShadowHtml(root: ShadowRoot | HTMLElement, html: string): void {
  const { markup, styles } = splitStyleBlocks(html);
  const sheetConstructor = (globalThis as typeof globalThis & { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
  if (
    typeof ShadowRoot !== "undefined" &&
    root instanceof ShadowRoot &&
    sheetConstructor &&
    typeof sheetConstructor.prototype.replaceSync === "function"
  ) {
    let sheet = adoptedSheets.get(root);
    if (!sheet) {
      sheet = new sheetConstructor();
      adoptedSheets.set(root, sheet);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(styles.join("\n"));
    root.innerHTML = markup;
    return;
  }
  root.innerHTML = html;
}
