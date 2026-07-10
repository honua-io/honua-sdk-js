export interface IncidentLifecycle {
  readonly disposed: boolean;
  own(cleanup: () => void): void;
  dispose(): readonly unknown[];
}

export function createIncidentLifecycle(): IncidentLifecycle {
  const cleanups: Array<() => void> = [];
  let disposed = false;

  return {
    get disposed() {
      return disposed;
    },
    own(cleanup) {
      if (disposed) {
        cleanup();
        return;
      }
      cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return [];
      disposed = true;
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      cleanups.length = 0;
      return errors;
    },
  };
}

export interface IncidentMapLoadErrorEvent {
  readonly error?: { readonly message?: string };
}

export interface IncidentMapLoadTarget {
  on(type: "load", listener: () => void): void;
  on(type: "error", listener: (event: IncidentMapLoadErrorEvent) => void): void;
  off(type: "load", listener: () => void): void;
  off(type: "error", listener: (event: IncidentMapLoadErrorEvent) => void): void;
  remove(): void;
}

export function initializeIncidentMap<T>(map: IncidentMapLoadTarget, initialize: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanupListeners = () => {
      map.off("load", onLoad);
      map.off("error", onError);
    };
    const fail = (error: unknown) => {
      cleanupListeners();
      try {
        map.remove();
      } finally {
        reject(error);
      }
    };
    const onLoad = () => {
      try {
        const value = initialize();
        cleanupListeners();
        resolve(value);
      } catch (error) {
        fail(error);
      }
    };
    const onError = (event: IncidentMapLoadErrorEvent) => {
      fail(new Error(event.error?.message ?? "Map failed to load"));
    };
    map.on("load", onLoad);
    map.on("error", onError);
  });
}
