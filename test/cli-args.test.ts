import { describe, expect, it } from "vitest";

import {
  ArgError,
  getArray,
  getBoolean,
  getNumber,
  getString,
  parseArgs,
  parseBbox,
  parseServiceLayer,
} from "../src/cli/args.js";
import type { FlagSpec } from "../src/cli/args.js";

const SPECS: FlagSpec[] = [
  { name: "where" },
  { name: "bbox" },
  { name: "limit" },
  { name: "fields", multiple: true },
  { name: "count", boolean: true },
  { name: "json", boolean: true },
  { name: "output", alias: "o" },
];

describe("parseArgs", () => {
  it("parses positionals, value flags, and boolean flags", () => {
    const parsed = parseArgs(["maui-parcels/1", "--where", "TMK > 0", "--count", "--limit", "5"], SPECS);
    expect(parsed.positionals).toEqual(["maui-parcels/1"]);
    expect(getString(parsed, "where")).toBe("TMK > 0");
    expect(getBoolean(parsed, "count")).toBe(true);
    expect(getNumber(parsed, "limit")).toBe(5);
  });

  it("supports --flag=value and short aliases", () => {
    const parsed = parseArgs(["--limit=10", "-o", "out.png"], SPECS);
    expect(getNumber(parsed, "limit")).toBe(10);
    expect(getString(parsed, "output")).toBe("out.png");
  });

  it("collects repeated flags into an array", () => {
    const parsed = parseArgs(["--fields", "TMK", "--fields", "ACRES"], SPECS);
    expect(getArray(parsed, "fields")).toEqual(["TMK", "ACRES"]);
  });

  it("treats everything after -- as positional", () => {
    const parsed = parseArgs(["query", "--", "--not-a-flag"], SPECS);
    expect(parsed.positionals).toEqual(["query", "--not-a-flag"]);
  });

  it("throws ArgError on unknown flags", () => {
    expect(() => parseArgs(["--nope"], SPECS)).toThrow(ArgError);
  });

  it("throws ArgError when a value flag is missing its value", () => {
    expect(() => parseArgs(["--where"], SPECS)).toThrow(ArgError);
  });

  it("rejects non-numeric --limit", () => {
    const parsed = parseArgs(["--limit", "abc"], SPECS);
    expect(() => getNumber(parsed, "limit")).toThrow(ArgError);
  });
});

describe("parseBbox", () => {
  it("parses a 4-tuple", () => {
    expect(parseBbox("-156.7,20.7,-156.3,21.0")).toEqual([-156.7, 20.7, -156.3, 21.0]);
  });

  it("rejects malformed bboxes", () => {
    expect(() => parseBbox("1,2,3")).toThrow(ArgError);
    expect(() => parseBbox("a,b,c,d")).toThrow(ArgError);
  });
});

describe("parseServiceLayer", () => {
  it("splits service/layer", () => {
    expect(parseServiceLayer("maui-parcels/1")).toEqual({ service: "maui-parcels", layer: 1 });
  });

  it("keeps slashes in the service id and uses the last segment as the layer", () => {
    expect(parseServiceLayer("folder/svc/3")).toEqual({ service: "folder/svc", layer: 3 });
  });

  it("rejects missing or non-integer layer ids", () => {
    expect(() => parseServiceLayer("maui-parcels")).toThrow(ArgError);
    expect(() => parseServiceLayer("maui-parcels/x")).toThrow(ArgError);
  });
});
