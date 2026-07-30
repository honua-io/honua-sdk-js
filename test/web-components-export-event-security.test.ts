// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { containsCredentialMaterial } from "../src/web-components/index.js";
import type { HonuaPrintExportElement } from "../src/web-components/index.js";
import "../src/web-components/index.js";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
});

describe("secure export event projection (issue #683, REQ-002)", () => {
  it("redacts adapter identity and failure text from events and visible status", async () => {
    const secret = `Bearer ${"a".repeat(48)}`;
    const adapterId = `renderer-${secret}`;
    const element = document.createElement("honua-print-export") as HonuaPrintExportElement;
    element.setAttribute("title", secret);
    document.body.append(element);
    mounted.push(element);

    const events: unknown[] = [];
    element.addEventListener("honua-export", (event) => events.push((event as CustomEvent).detail));
    element.exportAdapter = {
      id: adapterId,
      describeCapabilities: () => ({ adapterId, kinds: ["state"], cancellable: false }),
      exportState: () => {
        throw new Error(`renderer failed while reading ${secret}`);
      },
    };

    const result = await element.requestExport("state");
    expect(result.status).toBe("error");
    expect(events).toHaveLength(1);

    const eventDetail = events[0];
    const surfaced = JSON.stringify({ eventDetail, status: element.shadowRoot?.textContent });
    expect(surfaced).not.toContain(secret);
    expect(containsCredentialMaterial(surfaced)).toBe(false);
    expect(eventDetail).toMatchObject({ exportStatus: "error", kind: "state" });
    expect((eventDetail as { adapterId?: string }).adapterId).not.toBe(adapterId);
    expect(element.shadowRoot?.textContent).not.toContain(secret);
  });
});
