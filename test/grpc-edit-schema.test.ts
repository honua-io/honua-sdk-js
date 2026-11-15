import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { HonuaAbortError, HonuaGrpcError, HonuaTimeoutError } from "../src/core/errors.js";
import { memoizedGrpcEditSchema } from "../src/core/grpc-edit-schema.js";
import { DescribeLayerResponseSchema } from "../src/gen/geospatial/v1/index.js";

it("does not start DescribeLayer when the caller is already aborted", async () => {
  const describeLayer = vi.fn();
  const read = memoizedGrpcEditSchema({ describeLayer }, "inspections", 0);
  const signal = AbortSignal.abort();
  await expect(read(signal)).rejects.toBeInstanceOf(HonuaAbortError);
  expect(describeLayer).not.toHaveBeenCalled();
  describeLayer.mockResolvedValue(create(DescribeLayerResponseSchema, {}));
  await expect(read()).resolves.toEqual({ attributeTypes: {} });
  expect(describeLayer).toHaveBeenCalledTimes(1);
});

it("reports a DescribeLayer timeout as a timeout and does not cache it", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  });
  let calls = 0;
  const read = memoizedGrpcEditSchema(
    {
      describeLayer: (request) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          const fail = () => reject(new HonuaGrpcError(1, "canceled"));
          if (request.signal?.aborted) fail();
          else request.signal?.addEventListener("abort", fail, { once: true });
        }),
    },
    "inspections",
    0,
  );
  await expect(read()).rejects.toBeInstanceOf(HonuaTimeoutError);
  await expect(read()).rejects.toBeInstanceOf(HonuaTimeoutError);
  expect(calls).toBe(2);
  expect(timeout).toHaveBeenCalledWith(30_000);
  timeout.mockRestore();
});

it("still caches an unimplemented DescribeLayer", async () => {
  const describeLayer = vi.fn(async () => {
    throw new HonuaGrpcError(12, "unimplemented");
  });
  const read = memoizedGrpcEditSchema({ describeLayer }, "inspections", 0);
  await expect(read()).resolves.toEqual({ attributeTypes: {} });
  await expect(read()).resolves.toEqual({ attributeTypes: {} });
  expect(describeLayer).toHaveBeenCalledTimes(1);
});
