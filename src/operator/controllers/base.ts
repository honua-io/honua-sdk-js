/**
 * Tiny shared subscribe/notify helper for operator controllers. Mirrors
 * the listener-set pattern used by `HonuaMapRuntime` and
 * `ExplorationContext` so a single embedder hook style works everywhere.
 *
 * @module
 */

import type { OperatorTelemetry, OperatorTelemetryKind, OperatorTelemetrySpan } from "../telemetry.js";

export type Unsubscribe = () => void;

export class ListenerBag<E> {
  readonly #listeners = new Set<(event: E) => void>();

  public on(listener: (event: E) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public emit(event: E): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  public clear(): void {
    this.#listeners.clear();
  }

  public get size(): number {
    return this.#listeners.size;
  }
}

/**
 * Run an async operation with telemetry spans wrapped around it. Mirrors
 * the before/after/error semantics of `HonuaRuntimeTelemetry`.
 */
export async function withTelemetrySpan<T>(
  telemetry: OperatorTelemetry | undefined,
  kind: OperatorTelemetryKind,
  intentId: string | undefined,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>,
): Promise<T> {
  const span: OperatorTelemetrySpan = { kind, intentId, startedAt: Date.now(), detail };
  telemetry?.before?.(span);
  try {
    const result = await fn();
    const finishedAt = Date.now();
    telemetry?.after?.({ ...span, finishedAt, durationMs: finishedAt - span.startedAt });
    return result;
  } catch (error) {
    const finishedAt = Date.now();
    telemetry?.error?.({ ...span, finishedAt, durationMs: finishedAt - span.startedAt, error });
    throw error;
  }
}

/**
 * Telemetry counterpart for synchronous events that have no
 * before/after wrap (e.g. an audit-record fan-out).
 */
export function emitTelemetryEvent(
  telemetry: OperatorTelemetry | undefined,
  kind: OperatorTelemetryKind,
  intentId: string | undefined,
  detail?: Record<string, unknown>,
): void {
  const startedAt = Date.now();
  telemetry?.after?.({ kind, intentId, startedAt, finishedAt: startedAt, durationMs: 0, detail });
}
