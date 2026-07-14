export type SampleCleanup = () => void | Promise<void>;

interface Removable {
  remove(): void;
}

interface Disposable {
  dispose(): void | Promise<void>;
}

interface Unsubscribable {
  unsubscribe(): void;
}

interface Terminable {
  terminate(): void;
}

interface Closable {
  close(): void | Promise<void>;
}

export class SampleCleanupRegistry {
  readonly #cleanups: SampleCleanup[] = [];
  #state: "open" | "disposing" | "disposed" = "open";
  #disposePromise?: Promise<void>;

  get disposed(): boolean {
    return this.#state === "disposed";
  }

  add(cleanup: SampleCleanup): SampleCleanup {
    if (this.#state === "disposed") throw new Error("cannot register cleanup after disposal completed");
    this.#cleanups.push(cleanup);
    return cleanup;
  }

  resource(resource: Removable | Disposable | Unsubscribable | Terminable | Closable): void {
    if ("unsubscribe" in resource) this.add(() => resource.unsubscribe());
    else if ("terminate" in resource) this.add(() => resource.terminate());
    else if ("dispose" in resource) this.add(() => resource.dispose());
    else if ("remove" in resource) this.add(() => resource.remove());
    else this.add(() => resource.close());
  }

  listen<T extends EventTarget>(
    target: T,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    try {
      this.add(() => target.removeEventListener(type, listener, options));
    } catch (error) {
      target.removeEventListener(type, listener, options);
      throw error;
    }
  }

  timeout(callback: () => void, milliseconds: number): number {
    const handle = window.setTimeout(callback, milliseconds);
    try {
      this.add(() => window.clearTimeout(handle));
    } catch (error) {
      window.clearTimeout(handle);
      throw error;
    }
    return handle;
  }

  interval(callback: () => void, milliseconds: number): number {
    const handle = window.setInterval(callback, milliseconds);
    try {
      this.add(() => window.clearInterval(handle));
    } catch (error) {
      window.clearInterval(handle);
      throw error;
    }
    return handle;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#state = "disposing";
    this.#disposePromise = (async () => {
      const failures: unknown[] = [];
      while (this.#cleanups.length > 0) {
        for (const cleanup of this.#cleanups.splice(0).reverse()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        await Promise.resolve();
      }
      this.#state = "disposed";
      if (failures.length > 0) throw new AggregateError(failures, "sample cleanup failed");
    })();
    return this.#disposePromise;
  }
}
