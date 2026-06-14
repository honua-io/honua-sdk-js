import { describe, expect, it } from "vitest";

import {
  type ElevationCoordinate,
  decodeElevationPixel,
  decodeTerrainRgbElevation,
  decodeTerrariumElevation,
  haversineMeters,
  sampleElevationProfile,
} from "../src/core/terrain-elevation.js";

describe("Terrain-RGB / Terrarium pixel decoding", () => {
  it("decodes Mapbox Terrain-RGB pixels against known values", () => {
    // Mapbox docs reference: height = -10000 + (R*256*256 + G*256 + B) * 0.1
    expect(decodeTerrainRgbElevation(0, 0, 0)).toBe(-10_000);
    // The "1, 134, 160" sample used by the terrain example decodes to 0 m.
    expect(decodeTerrainRgbElevation(1, 134, 160)).toBeCloseTo(0, 6);
    expect(decodeTerrainRgbElevation(1, 134, 161)).toBeCloseTo(0.1, 6);
    // 100m above sea level => 101000 encoded units => R=1, G=138, B=136.
    expect(decodeTerrainRgbElevation(1, 138, 136)).toBeCloseTo(100, 6);
  });

  it("decodes Terrarium pixels against known values", () => {
    // Terrarium: height = (R*256 + G + B/256) - 32768
    expect(decodeTerrariumElevation(128, 0, 0)).toBe(0);
    expect(decodeTerrariumElevation(128, 100, 0)).toBe(100);
    expect(decodeTerrariumElevation(127, 0, 0)).toBe(-256);
    expect(decodeTerrariumElevation(128, 0, 128)).toBeCloseTo(0.5, 6);
  });

  it("dispatches encoding by name and clamps out-of-range channels", () => {
    expect(decodeElevationPixel("mapbox", 0, 0, 0)).toBe(-10_000);
    expect(decodeElevationPixel("terrarium", 128, 0, 0)).toBe(0);
    // Out-of-range channels clamp to the 0–255 byte range.
    expect(decodeElevationPixel("mapbox", -5, 0, 0)).toBe(decodeTerrainRgbElevation(0, 0, 0));
    expect(decodeElevationPixel("terrarium", 300, 0, 0)).toBe(decodeTerrariumElevation(255, 0, 0));
  });
});

describe("haversineMeters", () => {
  it("measures roughly 111 km per degree of latitude", () => {
    const meters = haversineMeters([0, 0], [0, 1]);
    expect(meters).toBeGreaterThan(110_000);
    expect(meters).toBeLessThan(112_000);
  });

  it("returns zero for identical coordinates", () => {
    expect(haversineMeters([-157.84, 21.42], [-157.84, 21.42])).toBe(0);
  });
});

describe("sampleElevationProfile", () => {
  const line: readonly ElevationCoordinate[] = [
    [0, 0],
    [0, 1],
  ];

  it("samples evenly spaced points with cumulative distance and elevation", async () => {
    const profile = await sampleElevationProfile({
      line,
      sampleCount: 3,
      // Elevation grows linearly with the second coordinate (latitude).
      sampler: (coordinate) => coordinate[1] * 1000,
    });

    expect(profile.samples).toHaveLength(3);
    expect(profile.samples[0]?.distanceMeters).toBe(0);
    expect(profile.samples[2]?.distanceMeters).toBeCloseTo(profile.totalDistanceMeters, 6);
    // Midpoint sits halfway along the line.
    expect(profile.samples[1]?.coordinate[1]).toBeCloseTo(0.5, 6);
    expect(profile.samples.map((s) => s.elevationMeters)).toEqual([0, 500, 1000]);
  });

  it("summarizes gain, loss, min, and max elevation", async () => {
    const elevations = [100, 250, 120];
    let call = 0;
    const profile = await sampleElevationProfile({
      line,
      sampleCount: 3,
      sampler: () => elevations[call++] ?? 0,
    });

    expect(profile.minElevationMeters).toBe(100);
    expect(profile.maxElevationMeters).toBe(250);
    expect(profile.gainMeters).toBe(150);
    expect(profile.lossMeters).toBe(130);
  });

  it("awaits async samplers and exposes index + distance context", async () => {
    const seen: Array<{ index: number; distanceMeters: number }> = [];
    const profile = await sampleElevationProfile({
      line,
      sampleCount: 2,
      sampler: async (_coordinate, context) => {
        seen.push(context);
        return 42;
      },
    });

    expect(profile.samples.every((s) => s.elevationMeters === 42)).toBe(true);
    expect(seen.map((c) => c.index)).toEqual([0, 1]);
    expect(seen[0]?.distanceMeters).toBe(0);
  });

  it("treats non-finite sampler results as no-data (0) in the summary", async () => {
    const profile = await sampleElevationProfile({
      line,
      sampleCount: 2,
      sampler: () => Number.NaN,
    });
    expect(profile.samples.map((s) => s.elevationMeters)).toEqual([0, 0]);
    expect(profile.maxElevationMeters).toBe(0);
  });

  it("defaults sampleCount to the line vertex count (min 2)", async () => {
    const polyline: readonly ElevationCoordinate[] = [
      [0, 0],
      [0, 0.5],
      [0, 1],
    ];
    const profile = await sampleElevationProfile({ line: polyline, sampler: () => 0 });
    expect(profile.samples).toHaveLength(3);
  });

  it("throws on a degenerate line", async () => {
    await expect(sampleElevationProfile({ line: [[0, 0]], sampler: () => 0 })).rejects.toBeInstanceOf(RangeError);
  });
});
