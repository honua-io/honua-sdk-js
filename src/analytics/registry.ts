/**
 * Adapter registry and honest presentation resolution.
 *
 * A host registers the adapters it is willing to use; the registry answers
 * "who can present this artifact?" and always has an answer, because the
 * accessible-table adapter is registered last and supports everything. That is
 * what turns an unsupported visualization request into a truthful table
 * instead of a blank panel.
 *
 * The registry holds adapters, not artifacts and not data.
 *
 * @experimental
 * @module
 */

import { createAccessibleTableAdapter } from "./accessible-table.js";
import { assertAnalyticsContractVersion } from "./artifact.js";
import { HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsArtifact,
  AnalyticsPresentationAdapter,
  AnalyticsSupportDecision,
  AnalyticsUnsupportedReason,
} from "./types.js";

/** Which adapter will present an artifact, and what was rejected on the way. */
export interface AnalyticsPresentationResolution {
  readonly adapter: AnalyticsPresentationAdapter;
  /** True when every preferred adapter declined and the fallback was used. */
  readonly fallback: boolean;
  /** Adapters that declined, with their machine-readable reasons. */
  readonly rejected: ReadonlyArray<{
    readonly adapterId: string;
    readonly reason: AnalyticsUnsupportedReason;
    readonly message: string;
  }>;
  /** Notes the winning adapter attached to its support decision. */
  readonly notes: readonly string[];
}

/** Registry of analytics presentation adapters. */
export interface AnalyticsAdapterRegistry {
  /** Registered adapters in preference order (the fallback is always last). */
  readonly adapters: readonly AnalyticsPresentationAdapter[];
  /**
   * Register an adapter ahead of the fallback. Throws on a duplicate id or an
   * incompatible contract major version.
   */
  register(adapter: AnalyticsPresentationAdapter): void;
  unregister(adapterId: string): boolean;
  get(adapterId: string): AnalyticsPresentationAdapter;
  /** Resolve the adapter that will present `artifact`. Never throws. */
  resolve(artifact: AnalyticsArtifact, options?: ResolveAnalyticsPresentationOptions): AnalyticsPresentationResolution;
}

/** Options for {@link AnalyticsAdapterRegistry.resolve}. */
export interface ResolveAnalyticsPresentationOptions {
  /** Try this adapter first. Falls through normally when it declines. */
  readonly preferAdapterId?: string;
  /**
   * Skip adapters that need a DOM. Set for SSR / worker / test hosts.
   * @default false
   */
  readonly headlessOnly?: boolean;
}

/** Options for {@link createAnalyticsAdapterRegistry}. */
export interface CreateAnalyticsAdapterRegistryOptions {
  /** Adapters registered in preference order. */
  readonly adapters?: readonly AnalyticsPresentationAdapter[];
  /**
   * Replace the accessible-table fallback. Must support every kind — the
   * registry verifies this at construction time.
   */
  readonly fallback?: AnalyticsPresentationAdapter;
}

const ALL_KINDS = ["category", "histogram", "aggregate", "time-series"] as const;

function decisionFor(
  adapter: AnalyticsPresentationAdapter,
  artifact: AnalyticsArtifact,
  headlessOnly: boolean,
): AnalyticsSupportDecision {
  if (headlessOnly && adapter.requiresDom) {
    return {
      supported: false,
      reason: "peer-unavailable",
      message: `${adapter.id} requires a DOM but the host requested a headless presentation.`,
    };
  }
  if (!adapter.kinds.includes(artifact.kind)) {
    return {
      supported: false,
      reason: "kind-not-supported",
      message: `${adapter.id} does not present "${artifact.kind}" artifacts.`,
    };
  }
  try {
    return adapter.describeSupport(artifact);
  } catch (cause) {
    return {
      supported: false,
      reason: "artifact-invalid",
      message: `${adapter.id} failed to describe support: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** Create an adapter registry with the accessible-table fallback installed. */
export function createAnalyticsAdapterRegistry(
  options: CreateAnalyticsAdapterRegistryOptions = {},
): AnalyticsAdapterRegistry {
  const fallback = options.fallback ?? createAccessibleTableAdapter();
  for (const kind of ALL_KINDS) {
    if (!fallback.kinds.includes(kind)) {
      throw new HonuaAnalyticsError(
        "adapter-unsupported",
        `The analytics fallback adapter must support every artifact kind; "${fallback.id}" omits "${kind}".`,
        { adapterId: fallback.id, kind },
      );
    }
  }
  assertAnalyticsContractVersion(fallback.contractVersion, fallback.id);

  const preferred: AnalyticsPresentationAdapter[] = [];

  function all(): readonly AnalyticsPresentationAdapter[] {
    return [...preferred, fallback];
  }

  for (const adapter of options.adapters ?? []) {
    assertAnalyticsContractVersion(adapter.contractVersion, adapter.id);
    if (adapter.id === fallback.id || preferred.some((existing) => existing.id === adapter.id)) {
      throw new HonuaAnalyticsError("duplicate-adapter", `Adapter "${adapter.id}" is already registered.`, {
        adapterId: adapter.id,
      });
    }
    preferred.push(adapter);
  }

  return {
    get adapters(): readonly AnalyticsPresentationAdapter[] {
      return all();
    },
    register(adapter): void {
      assertAnalyticsContractVersion(adapter.contractVersion, adapter.id);
      if (all().some((existing) => existing.id === adapter.id)) {
        throw new HonuaAnalyticsError("duplicate-adapter", `Adapter "${adapter.id}" is already registered.`, {
          adapterId: adapter.id,
        });
      }
      preferred.push(adapter);
    },
    unregister(adapterId): boolean {
      const index = preferred.findIndex((adapter) => adapter.id === adapterId);
      if (index === -1) return false;
      preferred.splice(index, 1);
      return true;
    },
    get(adapterId): AnalyticsPresentationAdapter {
      const adapter = all().find((candidate) => candidate.id === adapterId);
      if (!adapter) {
        throw new HonuaAnalyticsError("adapter-not-registered", `No analytics adapter "${adapterId}" is registered.`, {
          adapterId,
          registered: all().map((candidate) => candidate.id),
        });
      }
      return adapter;
    },
    resolve(artifact, resolveOptions = {}): AnalyticsPresentationResolution {
      const headlessOnly = resolveOptions.headlessOnly ?? false;
      const ordered = resolveOptions.preferAdapterId
        ? [
            ...preferred.filter((adapter) => adapter.id === resolveOptions.preferAdapterId),
            ...preferred.filter((adapter) => adapter.id !== resolveOptions.preferAdapterId),
          ]
        : preferred;

      const rejected: Array<{ adapterId: string; reason: AnalyticsUnsupportedReason; message: string }> = [];
      for (const adapter of ordered) {
        const decision = decisionFor(adapter, artifact, headlessOnly);
        if (decision.supported) {
          return { adapter, fallback: false, rejected, notes: decision.notes ?? [] };
        }
        rejected.push({ adapterId: adapter.id, reason: decision.reason, message: decision.message });
      }

      const fallbackDecision = decisionFor(fallback, artifact, headlessOnly);
      return {
        adapter: fallback,
        fallback: true,
        rejected,
        notes: fallbackDecision.supported ? (fallbackDecision.notes ?? []) : [fallbackDecision.message],
      };
    },
  };
}
