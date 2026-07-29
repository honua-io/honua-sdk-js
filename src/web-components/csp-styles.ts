const adoptedSheets = new WeakMap<object, CSSStyleSheet>();

/**
 * Moves static `<style>` blocks into a constructable stylesheet when the DOM
 * supports it. The inline fallback preserves headless/jsdom compatibility.
 */
export function renderCspSafeShadowHtml(root: ShadowRoot | HTMLElement, html: string): void {
  const styles: string[] = [];
  const markup = html.replace(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    styles.push(css);
    return "";
  });
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
