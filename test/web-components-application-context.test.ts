// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HONUA_APPLICATION_CONTEXT_VERSION,
  createHonuaApplicationContext,
  mountHonuaApplication,
  presentHonuaApplicationStatus,
  registerHonuaApplicationComponents,
} from "../src/web-components/application-context.js";
import type {
  HonuaApplicationContext,
  HonuaApplicationContextChangeEvent,
} from "../src/web-components/application-context.js";
import { HonuaFeatureInspectionElement } from "../src/web-components/feature-inspection.js";

const mounted: { dispose(): void }[] = [];

afterEach(() => {
  for (const mount of mounted.splice(0)) mount.dispose();
  document.body.replaceChildren();
});

describe("supported application context", () => {
  it("owns every versioned application slice and publishes immutable changes", () => {
    const changes: HonuaApplicationContextChangeEvent[] = [];
    const context = createHonuaApplicationContext({
      binding: { sourceIdentity: "incidents", planIdentity: "plan:1" },
      authorization: { status: "authorized", principalId: "operator-1", scopes: ["write", "read"] },
      onChange: (event) => changes.push(event),
    });

    expect(context.version).toBe(HONUA_APPLICATION_CONTEXT_VERSION);
    expect(context.snapshot).toMatchObject({
      version: 1,
      revision: 0,
      invalidationGeneration: 0,
      binding: { sourceIdentity: "incidents", planIdentity: "plan:1" },
      authorization: { status: "authorized", scopes: ["read", "write"] },
    });
    expect(Object.isFrozen(context.snapshot)).toBe(true);

    const next = context.update({
      status: "ready",
      viewport: { zoom: 10 },
      filters: [{ field: "status", value: "open" }],
      selection: [{ sourceId: "incidents", featureId: 7 }],
      time: { start: 1, end: 2, current: 1 },
      edits: [{ featureId: 7, dirty: true }],
      freshness: { state: "current", observedAt: "2026-08-14T00:00:00Z", generation: 4 },
      diagnostics: [{ code: "source-ready", message: "Ready", severity: "info" }],
    });

    expect(next).toMatchObject({ status: "ready", revision: 1, invalidationGeneration: 4 });
    expect(next.filters).toHaveLength(1);
    expect(next.selection).toHaveLength(1);
    expect(next.time).toEqual({ start: 1, end: 2, current: 1 });
    expect(next.edits).toHaveLength(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed).toEqual(
      expect.arrayContaining(["status", "viewport", "filters", "selection", "time", "edits", "freshness"]),
    );
  });

  it("deduplicates requests and aborts owned work before source or authorization state is exposed", async () => {
    const context = createHonuaApplicationContext({
      status: "ready",
      binding: { sourceIdentity: "incidents", planIdentity: "plan:1" },
      selection: [1],
      edits: [{ dirty: true }],
      authorization: { status: "authorized", principalId: "alice", scopes: ["read"] },
    });
    let calls = 0;
    let aborted = false;
    const request = (signal: AbortSignal): Promise<string> => {
      calls += 1;
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve("aborted");
          },
          { once: true },
        );
      });
    };

    const first = context.runSharedRequest("incidents:plan:1", request);
    const second = context.runSharedRequest("incidents:plan:1", request);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);

    let observedAuthorization = "";
    context.subscribe((event) => {
      if (event.reason === "authorization-replacement") {
        observedAuthorization = event.current.authorization.principalId ?? "none";
        expect(event.current.selection).toEqual([]);
        expect(event.current.edits).toEqual([]);
      }
    });
    context.replaceAuthorization({ status: "authorized", principalId: "bob", scopes: ["read"] });

    await expect(first).resolves.toBe("aborted");
    expect(aborted).toBe(true);
    expect(observedAuthorization).toBe("bob");
    expect(context.snapshot).toMatchObject({
      status: "loading",
      invalidationGeneration: 1,
      freshness: { state: "unknown", generation: 1 },
    });
  });

  it("applies realtime work only to the active source and accepted plan identity", () => {
    const context = createHonuaApplicationContext({
      binding: { sourceIdentity: "incidents", planIdentity: "plan:1" },
      status: "ready",
    });

    expect(
      context.applyRealtimeDelta({
        sourceIdentity: "parcels",
        planIdentity: "plan:1",
        mode: "patch",
        update: { selection: [1] },
      }),
    ).toBe(false);
    expect(context.snapshot.selection).toEqual([]);

    expect(
      context.applyRealtimeDelta({
        sourceIdentity: "incidents",
        planIdentity: "plan:1",
        mode: "patch",
        update: { selection: [7] },
      }),
    ).toBe(true);
    expect(context.snapshot).toMatchObject({ selection: [7], freshness: { state: "current" } });

    expect(
      context.applyRealtimeDelta({ sourceIdentity: "incidents", planIdentity: "plan:1", mode: "invalidate" }),
    ).toBe(true);
    expect(context.snapshot).toMatchObject({ status: "stale", freshness: { state: "stale" } });
  });

  it("localizes status, number, date, and unit formatting without global state", () => {
    const context = createHonuaApplicationContext({
      status: "loading",
      locale: {
        locale: "de-DE",
        direction: "ltr",
        status: { loading: "Wird geladen", offline: "Offline-Modus" },
        date: { timeZone: "UTC", year: "numeric" },
      },
    });

    expect(context.statusPresentation()).toMatchObject({
      label: "Wird geladen",
      role: "status",
      ariaLive: "polite",
      busy: true,
    });
    expect(context.formatNumber(1234.5)).toBe(new Intl.NumberFormat("de-DE").format(1234.5));
    expect(context.formatDate("2026-08-14T00:00:00Z")).toBe(
      new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", year: "numeric" }).format(new Date("2026-08-14T00:00:00Z")),
    );
    expect(context.formatUnit(5, "kilometer")).toContain("5");
    expect(presentHonuaApplicationStatus("failed")).toMatchObject({
      role: "alert",
      ariaLive: "assertive",
      recoverable: true,
    });
  });
});

describe("application context mount", () => {
  it("registers the canonical component suite from one idempotent call", async () => {
    const definitions = new Map<string, CustomElementConstructor>();
    const registry = {
      get: (name: string) => definitions.get(name),
      define: (name: string, elementClass: CustomElementConstructor) => {
        definitions.set(name, elementClass);
      },
    };

    await registerHonuaApplicationComponents(registry);
    const firstSize = definitions.size;
    await registerHonuaApplicationComponents(registry);

    expect(definitions.get("honua-map")).toBeDefined();
    expect(definitions.get("honua-feature-editor")).toBeDefined();
    expect(definitions.get("honua-feature-table")).toBeDefined();
    expect(firstSize).toBeGreaterThan(10);
    expect(definitions.size).toBe(firstSize);
  });

  it("binds current and future components once, projects theme/RTL, and disconnects deterministically", async () => {
    const connected = vi.fn();
    const changed = vi.fn();
    const disconnected = vi.fn();
    const tag = "honua-application-context-probe";
    if (!customElements.get(tag)) {
      customElements.define(
        tag,
        class extends HTMLElement {
          public applicationContext: HonuaApplicationContext | undefined;
          public honuaApplicationContextConnected = connected;
          public honuaApplicationContextChanged = changed;
          public honuaApplicationContextDisconnected = disconnected;
        },
      );
    }

    const host = document.createElement("main");
    host.setAttribute("lang", "en");
    const first = document.createElement(tag) as HTMLElement & { applicationContext?: HonuaApplicationContext };
    host.append(first);
    document.body.append(host);
    const context = createHonuaApplicationContext({
      status: "ready",
      locale: { locale: "ar", direction: "rtl" },
      theme: { accent: "#005ea8", foreground: "#111", reducedMotion: true },
    });
    const application = await mountHonuaApplication({ host, context, register: false });
    mounted.push(application);

    expect(first.applicationContext).toBe(context);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(host.getAttribute("lang")).toBe("ar");
    expect(host.getAttribute("dir")).toBe("rtl");
    expect(host.getAttribute("data-honua-status")).toBe("ready");
    expect(host.hasAttribute("data-honua-reduced-motion")).toBe(true);
    expect(host.style.getPropertyValue("--honua-ui-accent")).toBe("#005ea8");

    const statusEvent = vi.fn();
    host.addEventListener("honua-application-status-change", statusEvent);
    context.update({ status: "offline", locale: { locale: "he", direction: "rtl" } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(statusEvent).toHaveBeenCalledTimes(1);
    expect(host.getAttribute("lang")).toBe("he");
    expect(host.getAttribute("data-honua-status")).toBe("offline");

    const second = document.createElement(tag) as HTMLElement & { applicationContext?: HonuaApplicationContext };
    host.append(second);
    await Promise.resolve();
    expect(second.applicationContext).toBe(context);
    expect(connected).toHaveBeenCalledTimes(2);

    second.remove();
    await Promise.resolve();
    expect(second.applicationContext).toBeUndefined();
    expect(disconnected).toHaveBeenCalledTimes(1);

    application.dispose();
    expect(first.applicationContext).toBeUndefined();
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(context.disposed).toBe(false);
    expect(host.hasAttribute("data-honua-status")).toBe(false);
    expect(host.getAttribute("lang")).toBe("en");
  });

  it("disposes an internally owned context and supports SSR-safe mounting without an observer", async () => {
    const host = document.createElement("section");
    const originalObserver = globalThis.MutationObserver;
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: undefined });
    try {
      const application = await mountHonuaApplication({ host, register: false });
      expect(application.context.disposed).toBe(false);
      application.dispose();
      expect(application.context.disposed).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: originalObserver });
    }
  });

  it("delivers each mounted context change to a self-contained component exactly once", async () => {
    const tag = "honua-application-inspection-delivery-probe";
    const changed = vi.fn();
    if (!customElements.get(tag)) {
      customElements.define(
        tag,
        class extends HonuaFeatureInspectionElement {
          public override honuaApplicationContextChanged(event: HonuaApplicationContextChangeEvent): void {
            changed(event);
            super.honuaApplicationContextChanged(event);
          }
        },
      );
    }
    const host = document.createElement("main");
    host.append(document.createElement(tag));
    document.body.append(host);
    const context = createHonuaApplicationContext({ status: "ready" });
    const application = await mountHonuaApplication({ host, context, register: false });
    mounted.push(application);

    context.update({ status: "offline" });

    expect(changed).toHaveBeenCalledTimes(1);
  });
});
