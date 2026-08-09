import type { JobStatus } from "@honua/sdk-js/contract";

export interface BufferPoint {
  readonly label: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly projectedX: number;
  readonly projectedY: number;
  readonly srid: number;
}

export interface BufferInputs {
  readonly wkb: string;
  readonly srid: number;
  readonly distance: number;
}

export interface PolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

export interface BufferFeature {
  readonly type: "Feature";
  readonly geometry: PolygonGeometry;
  readonly properties: {
    readonly processId: string;
    readonly inputSrid: number;
    readonly bufferDistance: number;
  };
}

export interface BufferArtifact {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly href: string;
  readonly type: "application/geo+json";
}

export type WalkthroughStatus = "idle" | "submitting" | JobStatus;

export interface TimelineEntry {
  readonly id: number;
  readonly status: JobStatus;
  readonly label: string;
  readonly detail: string;
}

export interface WalkthroughSnapshot {
  readonly status: WalkthroughStatus;
  readonly busy: boolean;
  readonly timeline: readonly TimelineEntry[];
  readonly result: BufferFeature | undefined;
  readonly resultDigest: string | undefined;
  readonly error: string | undefined;
}

export interface FixtureExchange {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly prefer?: string | null;
}
