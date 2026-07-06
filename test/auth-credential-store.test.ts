import { describe, expect, it } from "vitest";

import {
  InMemoryCredentialStore,
  type StoredCredential,
  localStorageCredentialStore,
  sessionStorageCredentialStore,
} from "../src/core/auth/index.js";

const sample: StoredCredential = {
  accessToken: "token-a",
  refreshToken: "refresh-a",
  tokenType: "Bearer",
  expiresAt: 1_800_000_000_000,
};

/** Minimal in-memory Web Storage double. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
}

describe("InMemoryCredentialStore", () => {
  it("stores, reads, and deletes scoped credentials", () => {
    const store = new InMemoryCredentialStore();
    store.set("svc-a", sample);
    expect(store.get("svc-a")).toEqual(sample);
    // Scoping: a different service key never returns another service's token.
    expect(store.get("svc-b")).toBeUndefined();
    store.delete("svc-a");
    expect(store.get("svc-a")).toBeUndefined();
  });
});

describe("Web Storage credential adapters", () => {
  it("sessionStorage adapter round-trips JSON under a namespaced key", () => {
    const storage = fakeStorage();
    const store = sessionStorageCredentialStore({ storage });
    store.set("svc-a", sample);

    expect([...storage.map.keys()]).toEqual(["honua.auth:svc-a"]);
    expect(store.get("svc-a")).toEqual(sample);
    store.delete("svc-a");
    expect(store.get("svc-a")).toBeUndefined();
  });

  it("localStorage adapter honors a custom namespace", () => {
    const storage = fakeStorage();
    const store = localStorageCredentialStore({ storage, namespace: "acme.auth" });
    store.set("svc-a", sample);
    expect([...storage.map.keys()]).toEqual(["acme.auth:svc-a"]);
    expect(store.get("svc-a")).toEqual(sample);
  });

  it("returns undefined for corrupt stored JSON instead of throwing", () => {
    const storage = fakeStorage();
    storage.map.set("honua.auth:svc-a", "{not json");
    const store = sessionStorageCredentialStore({ storage });
    expect(store.get("svc-a")).toBeUndefined();
  });
});
