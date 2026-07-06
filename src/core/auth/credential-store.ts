/**
 * {@link CredentialStore} implementations.
 *
 * - {@link InMemoryCredentialStore} — the default. Tokens live only in the JS
 *   heap and vanish on reload; nothing else on the origin can read them.
 * - {@link sessionStorageCredentialStore} / {@link localStorageCredentialStore}
 *   — explicit opt-in Web Storage adapters. Web Storage is readable by **any**
 *   script executing on the origin, so a single XSS bug can exfiltrate every
 *   stored token. Only enable them when you understand and accept that risk
 *   (see `docs/auth.md` → "Storage & security"). `localStorage` additionally
 *   persists across tabs/restarts, widening the exposure window.
 *
 * @packageDocumentation
 */

import type { CredentialStore, StoredCredential } from "./types.js";

/**
 * Default credential store. Holds credentials in a process-local `Map` — never
 * serialized, never shared across origins, cleared on reload.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, StoredCredential>();

  public get(key: string): StoredCredential | undefined {
    return this.entries.get(key);
  }

  public set(key: string, value: StoredCredential): void {
    this.entries.set(key, value);
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }
}

/** Minimal Web Storage surface (`sessionStorage` / `localStorage`). */
interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface WebStorageCredentialStoreOptions {
  /**
   * Storage instance to use. Defaults to the matching global
   * (`sessionStorage` / `localStorage`) resolved lazily.
   */
  storage?: WebStorageLike;
  /** Key prefix for stored entries. Defaults to `honua.auth`. */
  namespace?: string;
}

class WebStorageCredentialStore implements CredentialStore {
  private readonly namespace: string;
  private readonly resolveStorage: () => WebStorageLike;

  public constructor(kind: "session" | "local", options: WebStorageCredentialStoreOptions) {
    this.namespace = options.namespace ?? "honua.auth";
    this.resolveStorage = () => {
      if (options.storage) {
        return options.storage;
      }
      const storage = kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
      if (!storage) {
        throw new Error(
          `${kind}Storage is unavailable in this environment. Pass an explicit \`storage\` adapter or use the in-memory store.`,
        );
      }
      return storage;
    };
  }

  private storageKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  public get(key: string): StoredCredential | undefined {
    const raw = this.resolveStorage().getItem(this.storageKey(key));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as StoredCredential;
    } catch {
      return undefined;
    }
  }

  public set(key: string, value: StoredCredential): void {
    this.resolveStorage().setItem(this.storageKey(key), JSON.stringify(value));
  }

  public delete(key: string): void {
    this.resolveStorage().removeItem(this.storageKey(key));
  }
}

/**
 * `sessionStorage`-backed credential store (per-tab, cleared when the tab
 * closes). Opt-in: see the module-level security note before using it.
 */
export function sessionStorageCredentialStore(options: WebStorageCredentialStoreOptions = {}): CredentialStore {
  return new WebStorageCredentialStore("session", options);
}

/**
 * `localStorage`-backed credential store (persists across tabs and restarts).
 * Highest-risk option — opt-in only. See the module-level security note.
 */
export function localStorageCredentialStore(options: WebStorageCredentialStoreOptions = {}): CredentialStore {
  return new WebStorageCredentialStore("local", options);
}
