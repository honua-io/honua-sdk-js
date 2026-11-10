import { expect, test, vi } from "vitest";
import { HonuaCatalogPicker, createCatalogSelectionResolver } from "../../src/controls/catalog-picker.js";
import type { HonuaCatalogSelection } from "../../src/controls/catalog-picker.js";
import type { HonuaOgcRecordResponse } from "../../src/core/types.js";

const record: HonuaOgcRecordResponse = { type: "Feature", id: "towns", geometry: null, properties: { title: "Towns" } };
const selection = {
  record,
  source: { descriptor: { id: "towns" } },
  dataset: { id: "catalog" },
  layer: { sourceId: "towns", layerIds: ["towns-fill"], remove: vi.fn() },
} as unknown as HonuaCatalogSelection;
const response = { type: "FeatureCollection" as const, features: [record] };

test("routes an approved record through discovery and mountSource using the identical analysis source", async () => {
  const connect = vi.fn().mockResolvedValue({ dataset: selection.dataset, source: () => selection.source });
  const dispose = vi.fn();
  const mountSource = vi.fn().mockResolvedValue({ sourceId: "towns", layerIds: ["towns-fill"], dispose });
  const map = {} as Parameters<typeof createCatalogSelectionResolver>[0]["map"];
  const optionsFor = vi.fn().mockReturnValue({
    endpoint: "https://data.example.test",
    protocol: "ogc-features",
    authorizationScopeFingerprint: "public",
  });
  const resolve = createCatalogSelectionResolver({ connect, mountSource, map, optionsFor });
  const signal = new AbortController().signal;
  const result = await resolve(record, signal);
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ protocol: "ogc-features", signal }));
  expect(mountSource).toHaveBeenCalledWith(map, selection.source, expect.objectContaining({ signal }));
  const sourceId = mountSource.mock.calls[0]?.[2]?.sourceId;
  expect(sourceId).toMatch(/^honua-catalog-selection-/);
  await resolve(record, signal);
  expect(mountSource.mock.calls[1]?.[2]?.sourceId).not.toBe(sourceId);
  expect(result?.source).toBe(selection.source);
  expect(result?.dataset).toBe(selection.dataset);
  result?.layer.remove();
  expect(dispose).toHaveBeenCalledOnce();
  optionsFor.mockReturnValue(undefined);
  expect(await resolve(record, signal)).toBeUndefined();
  expect(connect).toHaveBeenCalledTimes(2);
});

test("keeps the current layer until a replacement succeeds and disposes owned layers once", async () => {
  const first = { ...selection, layer: { ...selection.layer, remove: vi.fn() } };
  const next = { ...selection, layer: { ...selection.layer, remove: vi.fn() } };
  const resolve = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(undefined).mockResolvedValueOnce(next);
  const picker = new HonuaCatalogPicker({
    client: { searchOgcRecords: vi.fn().mockResolvedValue(response) },
    collectionId: "data",
    resolve,
  });
  await picker.search("");
  await picker.select(0);
  const mountedSignal = resolve.mock.calls[0]?.[1] as AbortSignal;
  await picker.search("again");
  expect(mountedSignal.aborted).toBe(false);
  await picker.select(0);
  expect(picker.state.selection).toBe(first);
  expect(first.layer.remove).not.toHaveBeenCalled();
  await picker.select(0);
  expect(first.layer.remove).toHaveBeenCalledOnce();
  picker.dispose();
  picker.dispose();
  expect(next.layer.remove).toHaveBeenCalledOnce();
});

test("searches the configured catalog through searchOgcRecords and resolves the exact result", async () => {
  const client = { searchOgcRecords: vi.fn().mockResolvedValue(response) };
  const resolve = vi.fn().mockResolvedValue(selection);
  const picker = new HonuaCatalogPicker({ client, collectionId: "data", resolve });
  await picker.search(" towns ");
  expect(client.searchOgcRecords).toHaveBeenCalledWith(
    expect.objectContaining({ collectionId: "data", q: "towns", limit: 25, signal: expect.any(AbortSignal) }),
  );
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
  const picker = new HonuaCatalogPicker({
    client,
    collectionId: "data",
    resolve: vi.fn().mockResolvedValue(undefined),
  });
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
  const client = {
    searchOgcRecords: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSearch = resolve;
          }),
      )
      .mockResolvedValue(response),
  };
  const picker = new HonuaCatalogPicker({
    client,
    collectionId: "data",
    resolve: () =>
      new Promise((resolve) => {
        finishSelect = resolve;
      }),
  });
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

test("retains every mounted layer when replacement cleanup fails", async () => {
  const oldRemove = vi.fn().mockImplementationOnce(() => {
    throw new Error("renderer cleanup failed");
  });
  const newRemove = vi.fn();
  const first = { ...selection, layer: { ...selection.layer, remove: oldRemove } };
  const next = { ...selection, layer: { ...selection.layer, remove: newRemove } };
  const picker = new HonuaCatalogPicker({
    client: { searchOgcRecords: vi.fn().mockResolvedValue(response) },
    collectionId: "data",
    resolve: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next),
  });
  await picker.search("");
  await picker.select(0);
  await picker.select(0);
  expect(picker.state.status).toBe("error");
  expect(picker.state.selection).toBe(first);
  expect(newRemove).toHaveBeenCalledOnce();
  picker.dispose();
  expect(oldRemove).toHaveBeenCalledTimes(2);
});
