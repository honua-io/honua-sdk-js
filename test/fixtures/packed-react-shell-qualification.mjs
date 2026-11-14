import assert from "node:assert/strict";

import * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

export async function qualifyPackedReactShell({ context, mountHonuaApplication }) {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const lifecycle = { effects: 0, cleanups: 0, mounted: 0, disposed: 0 };
  const hydrationErrors = [];
  const mountErrors = [];
  let statusEvents = 0;
  let root;

  function Shell() {
    const host = React.useRef(null);
    React.useEffect(() => {
      lifecycle.effects += 1;
      const element = host.current;
      const onStatus = () => { statusEvents += 1; };
      element.addEventListener("honua-application-status-change", onStatus);
      let cancelled = false;
      let mounted;
      // Registration can be asynchronous. A replayed or unmounted effect must
      // not attach a late context subscription to the replacement host.
      Promise.resolve().then(async () => {
        if (cancelled) return;
        mounted = await mountHonuaApplication({ host: element, context, register: false });
        lifecycle.mounted += 1;
        if (cancelled) dispose();
      }).catch((error) => { mountErrors.push(error); });
      function dispose() {
        if (!mounted || mounted.disposed) return;
        mounted.dispose();
        lifecycle.disposed += 1;
      }
      return () => {
        lifecycle.cleanups += 1;
        cancelled = true;
        element.removeEventListener("honua-application-status-change", onStatus);
        dispose();
      };
    }, []);
    return React.createElement("section", { ref: host, "aria-label": "React hosted component lane" },
      React.createElement("honua-feature-inspection", { id: "react-inspection" }),
    );
  }

  const tree = () => React.createElement(React.StrictMode, null, React.createElement(Shell));
  container.innerHTML = renderToString(tree());
  const serverElement = container.querySelector("#react-inspection");
  assert.ok(serverElement, "SSR must render the supported custom element");
  try {
    await React.act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError: (error) => hydrationErrors.push(error.message) });
    });
    assert.equal(container.querySelector("#react-inspection"), serverElement, "hydration must reuse the server element");
    assert.deepEqual(hydrationErrors, [], "hydration must not recover by replacing server markup");
    assert.deepEqual(mountErrors, [], "the React shell must mount without errors");
    assert.equal(lifecycle.effects, 2, "development StrictMode must replay the shell effect");
    assert.equal(lifecycle.cleanups, 1, "StrictMode must clean up the first effect");
    assert.equal(lifecycle.mounted - lifecycle.disposed, 1, "StrictMode must retain exactly one context mount");
    assert.equal(serverElement.applicationContext, context, "hydrated component must join the shared context");

    context.update({ status: "offline", locale: { locale: "de", direction: "ltr" } });
    assert.equal(statusEvents, 1, "status changes must not duplicate after effect replay");
    const shell = container.querySelector("section");
    assert.equal(shell.getAttribute("lang"), "de");
    assert.equal(shell.getAttribute("dir"), "ltr");
    await React.act(async () => { root.render(tree()); });
    assert.equal(container.querySelector("#react-inspection"), serverElement, "rerender must preserve component identity");
    assert.equal(lifecycle.effects, 2, "rerender must not mount another context");

    await React.act(async () => { root.unmount(); });
    root = undefined;
    assert.equal(lifecycle.mounted, lifecycle.disposed, "unmount must dispose every completed context mount");
    assert.equal(lifecycle.cleanups, lifecycle.effects, "unmount must clean up every effect");
    assert.equal(serverElement.applicationContext, undefined, "unmount must detach the component context");
    context.update({ status: "ready" });
    assert.equal(statusEvents, 1, "an unmounted shell must not receive further context events");
    return { hydration: "reused-server-node", ...lifecycle };
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    container.remove();
    if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}
