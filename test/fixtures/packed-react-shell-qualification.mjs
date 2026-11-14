import assert from "node:assert/strict";

import * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

function mountShellEffect(element, state) {
  state.lifecycle.effects += 1;
  const onStatus = () => { state.statusEvents += 1; };
  element.addEventListener("honua-application-status-change", onStatus);
  let cancelled = false;
  let mounted;
  // Registration can be asynchronous. A replayed or unmounted effect must
  // not attach a late context subscription to the replacement host.
  Promise.resolve().then(async () => {
    if (cancelled) return;
    mounted = await state.mountHonuaApplication({ host: element, context: state.context, register: false });
    state.lifecycle.mounted += 1;
    if (cancelled) dispose();
  }).catch((error) => { state.mountErrors.push(error); });
  function dispose() {
    if (!mounted || mounted.disposed) return;
    mounted.dispose();
    state.lifecycle.disposed += 1;
  }
  return () => {
    state.lifecycle.cleanups += 1;
    cancelled = true;
    element.removeEventListener("honua-application-status-change", onStatus);
    dispose();
  };
}

function createShell(state) {
  return function Shell() {
    const host = React.useRef(null);
    React.useEffect(() => mountShellEffect(host.current, state), []);
    return React.createElement("section", { ref: host, "aria-label": "React hosted component lane" },
      React.createElement("honua-feature-inspection", { id: "react-inspection" }),
    );
  };
}

function assertHydration(state, serverElement) {
  assert.equal(state.container.querySelector("#react-inspection"), serverElement, "hydration must reuse the server element");
  assert.deepEqual(state.hydrationErrors, [], "hydration must not recover by replacing server markup");
  assert.deepEqual(state.mountErrors, [], "the React shell must mount without errors");
  assert.equal(state.lifecycle.effects, 2, "development StrictMode must replay the shell effect");
  assert.equal(state.lifecycle.cleanups, 1, "StrictMode must clean up the first effect");
  assert.equal(state.lifecycle.mounted - state.lifecycle.disposed, 1, "StrictMode must retain exactly one context mount");
  assert.equal(serverElement.applicationContext, state.context, "hydrated component must join the shared context");
}


async function qualifyUpdates(state, tree, serverElement) {
  state.context.update({ status: "offline", locale: { locale: "de", direction: "ltr" } });
  assert.equal(state.statusEvents, 1, "status changes must not duplicate after effect replay");
  const shell = state.container.querySelector("section");
  assert.equal(shell.getAttribute("lang"), "de");
  assert.equal(shell.getAttribute("dir"), "ltr");
  await React.act(async () => { state.root.render(tree()); });
  assert.equal(state.container.querySelector("#react-inspection"), serverElement, "rerender must preserve component identity");
  assert.equal(state.lifecycle.effects, 2, "rerender must not mount another context");

  await React.act(async () => { state.root.unmount(); });
  state.root = undefined;
  assert.equal(state.lifecycle.mounted, state.lifecycle.disposed, "unmount must dispose every completed context mount");
  assert.equal(state.lifecycle.cleanups, state.lifecycle.effects, "unmount must clean up every effect");
  assert.equal(serverElement.applicationContext, undefined, "unmount must detach the component context");
  state.context.update({ status: "ready" });
  assert.equal(state.statusEvents, 1, "an unmounted shell must not receive further context events");
}


export async function qualifyPackedReactShell({ context, mountHonuaApplication }) {
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const lifecycle = { effects: 0, cleanups: 0, mounted: 0, disposed: 0 };
  const hydrationErrors = [];
  const mountErrors = [];
  const statusEvents = 0;

  const state = { context, mountHonuaApplication, container, lifecycle, hydrationErrors, mountErrors, statusEvents };
  const Shell = createShell(state);

  const tree = () => React.createElement(React.StrictMode, null, React.createElement(Shell));
  container.innerHTML = renderToString(tree());
  const serverElement = container.querySelector("#react-inspection");
  assert.ok(serverElement, "SSR must render the supported custom element");
  try {
    await React.act(async () => {
      state.root = hydrateRoot(container, tree(), { onRecoverableError: (error) => hydrationErrors.push(error.message) });
    });
    assertHydration(state, serverElement);
    await qualifyUpdates(state, tree, serverElement);
    state.root = undefined;
    return { hydration: "reused-server-node", ...lifecycle };
  } finally {
    if (state.root) await React.act(async () => { state.root.unmount(); });
    container.remove();
    if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}
