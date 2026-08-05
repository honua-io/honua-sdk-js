/**
 * Conformance-suite harness. Bridges the shared geospatial-grpc fixtures to a
 * live, pinned `honua-server` through the protocol-neutral `Dataset` →
 * `Source` → `Query` → `Result` contract, reusing the integration lane's
 * connect-only config, diagnostics, and reporter rather than inventing a new
 * transport path (REQ-004 / NFR-002).
 *
 * The conformance lane is double-gated:
 *   - `HONUA_INTEGRATION_BASE_URL` — a live, seeded, pinned server (same gate
 *     as the integration lane);
 *   - `HONUA_CONFORMANCE_FIXTURES_DIR` — an extracted
 *     `conformance-fixtures-<version>` bundle pulled by
 *     `conformance/fetch-fixtures.sh`.
 *
 * When either is unset the suite degrades to an explicit, labelled no-op
 * (`describe.skip`) so forks / unconfigured pushes never report a false green
 * (NFR-001 / REQ-006).
 *
 * @module
 */

import {
  type CreateDatasetOptions,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type Source,
  type SourceLocator,
  createDataset,
} from "@honua/sdk-js/contract";
import { beforeAll, describe } from "vitest";
import {
  type DiagnosticsContext,
  type IntegrationConfig,
  makeIntegrationClient,
  tryResolveIntegrationConfig,
} from "../integration/harness.js";
import { recordSurface } from "../integration/reporter.js";
import { type FixtureCase, assertFixturesVersion, loadFixtureCase, tryResolveFixturesDir } from "./fixtures.js";

export { runWithDiagnostics } from "../integration/harness.js";
export type { DiagnosticsContext } from "../integration/diagnostics.js";

/** Resolved gate for one conformance run. */
export interface ConformanceGate {
  config: IntegrationConfig;
  fixturesDir: string;
  fixturesVersion: string;
}

/**
 * Resolve the conformance gate, or `undefined` when the lane is not fully
 * configured. Validates the bundle VERSION against the pinned version so a
 * mismatched bundle aborts instead of testing the wrong contract.
 */
export function tryResolveConformanceGate(): ConformanceGate | undefined {
  const config = tryResolveIntegrationConfig();
  const fixturesDir = tryResolveFixturesDir();
  if (!config || !fixturesDir) return undefined;
  const fixturesVersion = assertFixturesVersion(fixturesDir);
  return { config, fixturesDir, fixturesVersion };
}

/** Handle handed to a conformance suite body. */
export interface ConformanceHandle<Req, Resp> {
  context: DiagnosticsContext;
  config: IntegrationConfig;
  fixture: FixtureCase<Req, Resp>;
  /**
   * Build a protocol-neutral `Source` for the fixture's service/layer over
   * the live client. `protocol` selects which adapter exercises the live
   * server (the contract is the same across protocols — that is the point).
   */
  source(protocol: Protocol, locator: SourceLocator, sourceId?: string): Source;
}

/**
 * Register a conformance suite for one fixture workflow. The body runs only
 * when both the live server and the fixtures are configured; otherwise the
 * suite is an explicit `describe.skip` and the surface is recorded as skipped.
 */
export function conformanceSuite<Req = Record<string, unknown>, Resp = Record<string, unknown>>(
  name: string,
  surface: string,
  workflowId: string,
  fn: (handle: ConformanceHandle<Req, Resp>) => void,
): void {
  const gate = tryResolveConformanceGate();
  if (!gate) {
    describe.skip(`${name} [conformance:${surface}]`, () => {
      // No-op: lane not configured (no live server and/or no fixtures bundle).
    });
    return;
  }
  const fixture = loadFixtureCase<Req, Resp>(gate.fixturesDir, workflowId);
  describe(`${name} [conformance:${surface}] (fixtures ${gate.fixturesVersion})`, () => {
    const { client, context, config } = makeIntegrationClient();
    beforeAll(() => {
      recordSurface(`conformance:${surface}`);
    });
    const handle: ConformanceHandle<Req, Resp> = {
      context,
      config,
      fixture,
      source(protocol, locator, sourceId = `conformance-${surface}`) {
        const options: CreateDatasetOptions = {
          id: `conformance-${surface}`,
          client,
          sources: [
            {
              id: sourceId,
              protocol,
              locator,
              capabilities: PROTOCOL_DEFAULT_CAPABILITIES[protocol],
            },
          ],
          // The compatibility envelope is recorded separately by the
          // integration global setup; skip the per-dataset gate so a
          // conformance failure surfaces as contract drift, not a
          // negotiation error.
          skipCompatibilityCheck: true,
        };
        const dataset = createDataset(options);
        const source = dataset.source(sourceId);
        if (!source) {
          throw new Error(`failed to construct ${protocol} source "${sourceId}" for conformance suite "${name}"`);
        }
        return source;
      },
    };
    fn(handle);
  });
}

/**
 * Register a conformance suite that is intentionally not exercised against the
 * live server yet because of a KNOWN, tracked server-side gap. Always
 * registers as `describe.skip` with the tracking issue in the title, and
 * records the surface as skipped (with the issue reference) in the integration
 * metadata — never a silent skip, never a blanket `continue-on-error`. When
 * the server gap lands, flip this back to {@link conformanceSuite}.
 */
export function knownGapConformanceSuite(name: string, surface: string, trackingIssue: string, fn: () => void): void {
  const gate = tryResolveConformanceGate();
  if (gate) {
    recordSurface(`conformance:${surface}`, `known-gap ${trackingIssue}`);
  }
  describe.skip(`${name} [conformance:${surface}] (KNOWN-EXPECTED-FAILING: ${trackingIssue})`, fn);
}
