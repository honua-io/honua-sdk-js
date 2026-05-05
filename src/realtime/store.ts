/**
 * Store and transport bridge for realtime feature state.
 *
 * @module
 */

import { emptyRealtimeFeatureState, reconcileRealtimeStaleness, reduceRealtimeFeatureState } from "./reducer.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureState,
  RealtimeFeatureTransport,
  RealtimeReducerOptions,
  RealtimeStalenessOptions,
  RealtimeStateListener,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "./types.js";

export interface RealtimeFeatureStore<TFeature = unknown> {
  readonly state: RealtimeFeatureState<TFeature>;
  apply(event: RealtimeFeatureEvent<TFeature>): RealtimeFeatureState<TFeature>;
  checkStale(options: RealtimeStalenessOptions): RealtimeFeatureState<TFeature>;
  subscribe(listener: RealtimeStateListener<TFeature>, options?: { readonly fireImmediately?: boolean }): () => void;
  connect(
    transport: RealtimeFeatureTransport<TFeature>,
    request: RealtimeSubscriptionRequest,
  ): RealtimeSubscriptionHandle;
  close(): void;
}

export function createRealtimeFeatureStore<TFeature = unknown>(
  initialState: RealtimeFeatureState<TFeature> = emptyRealtimeFeatureState<TFeature>(),
  options: RealtimeReducerOptions = {},
): RealtimeFeatureStore<TFeature> {
  let state = initialState;
  let activeHandle: RealtimeSubscriptionHandle | undefined;
  const listeners = new Set<RealtimeStateListener<TFeature>>();

  function emit(event: RealtimeFeatureEvent<TFeature> | undefined): void {
    for (const listener of [...listeners]) listener(state, event);
  }

  function setState(
    next: RealtimeFeatureState<TFeature>,
    event: RealtimeFeatureEvent<TFeature> | undefined,
  ): RealtimeFeatureState<TFeature> {
    if (Object.is(state, next)) return state;
    state = next;
    emit(event);
    return state;
  }

  return {
    get state() {
      return state;
    },
    apply(event) {
      return setState(reduceRealtimeFeatureState(state, event, options), event);
    },
    checkStale(stalenessOptions) {
      return setState(reconcileRealtimeStaleness(state, stalenessOptions), undefined);
    },
    subscribe(listener, subscribeOptions = {}) {
      listeners.add(listener);
      if (subscribeOptions.fireImmediately) listener(state, undefined);
      return () => {
        listeners.delete(listener);
      };
    },
    connect(transport, request) {
      activeHandle?.close();
      this.apply({ type: "status", status: "connecting" });
      activeHandle = transport.subscribe(request, {
        next: (event) => this.apply(event),
        error: (error) => this.apply({ type: "error", error }),
        complete: () => this.apply({ type: "status", status: "closed" }),
      });
      return {
        close: () => {
          activeHandle?.close();
          activeHandle = undefined;
          this.apply({ type: "status", status: "closed" });
        },
      };
    },
    close() {
      activeHandle?.close();
      activeHandle = undefined;
      setState({ ...state, status: "closed" }, { type: "status", status: "closed" });
      listeners.clear();
    },
  };
}
