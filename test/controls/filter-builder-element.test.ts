import { expect, test, vi } from "vitest";
import { HonuaFilterBuilderElement, defineHonuaFilterBuilder } from "../../src/controls/filter-builder-element.js";
import { createFilterRegistry } from "../../src/filter-registry/index.js";

const draft = {
  fields: [{ name: "people", type: "number" as const }],
  rows: [{ field: "people", operator: "gte" as const, value: "2" }],
  ownerId: "builder",
  sourceId: "towns",
};

test("loads without DOM and registers only on explicit request", () => {
  const define = vi.fn();
  defineHonuaFilterBuilder({ get: () => undefined, define } as unknown as CustomElementRegistry);
  expect(define).toHaveBeenCalledWith("honua-filter-builder", HonuaFilterBuilderElement);
});

test("clones drafts and clears only its owner on detach", async () => {
  const element = new HonuaFilterBuilderElement();
  const registry = createFilterRegistry();
  registry.upsert({ id: "chart", owner: { kind: "chart", id: "scatter" }, field: "people", operator: "<", value: 10 });
  element.registry = registry;
  element.draft = draft;
  const copy = element.draft!;
  (copy.rows as unknown[]).pop();
  expect(element.draft?.rows).toHaveLength(1);
  expect((await element.apply()).cql2).toBe("people >= 2");
  expect(registry.snapshot.clauses).toHaveLength(2);
  element.disconnectedCallback();
  expect(registry.snapshot.clauses.map((clause) => clause.id)).toEqual(["chart"]);
});

test("count failures do not undo a valid filter and stale counts cannot overwrite new ones", async () => {
  const element = new HonuaFilterBuilderElement();
  element.draft = draft;
  let finish: (value: number) => void = () => {};
  let signal: AbortSignal | undefined;
  element.countRows = (_query, abortSignal) => {
    signal = abortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = element.apply();
  expect(element.countStatus).toBe("Counting matching rows…");
  element.draft = { ...draft, rows: [] };
  expect(signal?.aborted).toBe(true);
  element.countRows = async () => 7;
  await element.apply();
  finish(100);
  await first;
  expect(element.countStatus).toBe("7 matching rows");
  element.countRows = async () => {
    throw new Error("private network error");
  };
  await expect(element.apply()).resolves.toMatchObject({ query: {} });
  expect(element.countStatus).toBe("Matching count unavailable.");
});

test("registry and owner changes remove stale filters without erasing other owners", async () => {
  const element = new HonuaFilterBuilderElement();
  const first = createFilterRegistry();
  const second = createFilterRegistry();
  element.registry = first;
  element.draft = draft;
  await element.apply();
  element.registry = second;
  expect(first.snapshot.clauses).toHaveLength(0);
  await element.apply();
  element.draft = { ...draft, ownerId: "next" };
  expect(second.snapshot.clauses).toHaveLength(0);
});
