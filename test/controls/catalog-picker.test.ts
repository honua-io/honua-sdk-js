import { expect, test, vi } from "vitest";
import { HonuaCatalogPicker } from "../../src/controls/catalog-picker.js";
import type { HonuaCatalogSelection } from "../../src/controls/catalog-picker.js";
import type { HonuaOgcRecordResponse } from "../../src/core/types.js";

const record: HonuaOgcRecordResponse = { type: "Feature", id: "towns", geometry: null, properties: { title: "Towns" } };
const selection = { record, source: { descriptor: { id: "towns" } }, dataset: { id: "catalog" }, layer: { sourceId: "towns", layerIds: ["towns-fill"], remove: vi.fn() } } as unknown as HonuaCatalogSelection;
const response = { type: "FeatureCollection" as const, features: [record] };

test("searches the configured catalog through searchOgcRecords and resolves the exact result", async () => {
  const client = { searchOgcRecords: vi.fn().mockResolvedValue(response) };
  const resolve = vi.fn().mockResolvedValue(selection);
  const picker = new HonuaCatalogPicker({ client, collectionId: "data", resolve });
  await picker.search(" towns ");
  expect(client.searchOgcRecords).toHaveBeenCalledWith(expect.objectContaining({ collectionId: "data", q: "towns", limit: 25, signal: expect.any(AbortSignal) }));
  expect(picker.state.status).toBe("ready");
  expect(await picker.select(0)).toBe(selection);
  expect(resolve).toHaveBeenCalledWith(record, expect.any(AbortSignal));
  expect(picker.state.selection?.source).toBe(selection.source);
});

test("does not execute invalid searches or unknown selections", async () => {
  const client = { searchOgcRecords: vi.fn() };
  const picker = new HonuaCatalogPicker({ client, collectionId: "data", resolve: vi.fn() });
  await expect(picker.search("x".repeat(257))).rejects.toThrow();
  await expect(picker.select(0)).rejects.toThrow();
  expect(client.searchOgcRecords).not.toHaveBeenCalled();
});

test("represents empty, failure and unsupported resolution without exposing transport error details", async () => {
  const client = { searchOgcRecords: vi.fn().mockResolvedValue({ ...response, features: [] }) };
  const picker = new HonuaCatalogPicker({ client, collectionId: "data", resolve: vi.fn().mockResolvedValue(undefined) });
  await picker.search("");
  expect(picker.state.status).toBe("empty");
  client.searchOgcRecords.mockRejectedValueOnce(new Error("authorization=private"));
  await picker.search("town");
  expect(picker.state.status).toBe("error");
  expect(JSON.stringify(picker.state)).not.toContain("private");
  client.searchOgcRecords.mockResolvedValue(response);
  await picker.search("town");
  expect(await picker.select(0)).toBeUndefined();
  expect(picker.state.status).toBe("unsupported");
});

test("ignores old search responses and disposes a stale selection layer", async () => {
  let finishSearch!: (value: typeof response) => void;
  let finishSelect!: (value: HonuaCatalogSelection) => void;
  const client = { searchOgcRecords: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishSearch = resolve; })).mockResolvedValue(response) };
  const picker = new HonuaCatalogPicker({ client, collectionId: "data", resolve: () => new Promise((resolve) => { finishSelect = resolve; }) });
  const old = picker.search("old");
  await picker.search("new");
  finishSearch({ ...response, features: [] });
  await old;
  expect(picker.state.status).toBe("ready");
  const pending = picker.select(0);
  picker.dispose();
  finishSelect(selection);
  expect(await pending).toBeUndefined();
  expect(selection.layer.remove).toHaveBeenCalledOnce();
});
