import type { RealtimeConnectionStatus } from "@honua/sdk-js/realtime";

import type { IncidentExecutionLane } from "./safe-edit.js";
import type { IncidentFeature } from "./types.js";

export interface IncidentConnectionPresentation {
  readonly laneLabel: string;
  readonly disclosure: string;
  readonly overlay: string;
  readonly overlayState: "loading" | "ready" | "degraded" | "error";
}

export function presentIncidentConnection(
  lane: IncidentExecutionLane,
  status: RealtimeConnectionStatus,
  authoritative: boolean,
  fallbackReason?: string,
): IncidentConnectionPresentation {
  if (lane === "replay") {
    return {
      laneLabel: "Replay fallback",
      disclosure: `Live was preferred but is unavailable. Scripted replay is read-only.${fallbackReason ? ` ${fallbackReason}` : ""}`,
      overlay: "Read-only replay fallback",
      overlayState: "degraded",
    };
  }

  if (lane === "fixture-edit") {
    const available = status === "live" && authoritative;
    return {
      laneLabel: "Isolated fixture lab",
      disclosure: available
        ? "Deterministic isolated stream/edit lab is ready. This is fixture evidence, never a live-data claim."
        : `Deterministic isolated stream/edit lab is ${status}. It is not authoritative live data.`,
      overlay: available ? "Isolated fixture stream/edit lab" : `Fixture stream ${status}`,
      overlayState: available ? "ready" : status === "error" ? "error" : "loading",
    };
  }

  if (status === "live" && authoritative) {
    return {
      laneLabel: "Live authoritative",
      disclosure: "The configured realtime source is open and observed feature state is authoritative.",
      overlay: "Live incident stream open and authoritative",
      overlayState: "ready",
    };
  }

  const state = liveSourceState(status);
  return {
    laneLabel: state.laneLabel,
    disclosure: state.disclosure,
    overlay: state.overlay,
    overlayState: state.overlayState,
  };
}

export function formatIncidentAccessibleName(incident: IncidentFeature): string {
  return `Open ${incident.title}, ${titleCase(incident.severity)} severity, ${titleCase(incident.status)} status`;
}

function liveSourceState(status: RealtimeConnectionStatus): IncidentConnectionPresentation {
  switch (status) {
    case "idle":
    case "connecting":
      return {
        laneLabel: "Live source selected",
        disclosure:
          "The configured realtime source is selected. Incident state is read-only and non-authoritative until the stream opens with verified feature provenance.",
        overlay: status === "idle" ? "Preparing live incident source" : "Connecting to live incident source",
        overlayState: "loading",
      };
    case "reconnecting":
      return {
        laneLabel: "Live source reconnecting",
        disclosure:
          "The realtime source is reconnecting. Last observed incident state is read-only and non-authoritative until authority resumes.",
        overlay: "Live incident stream reconnecting — read-only",
        overlayState: "degraded",
      };
    case "stale":
      return {
        laneLabel: "Live source stale",
        disclosure: "The realtime source is stale. Last observed incident state is read-only and non-authoritative.",
        overlay: "Live incident stream stale — read-only",
        overlayState: "degraded",
      };
    case "offline":
    case "closed":
      return {
        laneLabel: "Live source unavailable",
        disclosure: `The realtime source is ${status}. Last observed incident state is read-only and non-authoritative.`,
        overlay: `Live incident stream ${status} — read-only`,
        overlayState: "degraded",
      };
    case "error":
      return {
        laneLabel: "Live source error",
        disclosure: "The realtime source failed. Incident state is read-only and non-authoritative.",
        overlay: "Live incident stream error — read-only",
        overlayState: "error",
      };
    case "live":
      return {
        laneLabel: "Live source unverified",
        disclosure:
          "The stream is open, but feature provenance is not authoritative. Incident state remains read-only.",
        overlay: "Live stream open; authority not established",
        overlayState: "degraded",
      };
  }
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
