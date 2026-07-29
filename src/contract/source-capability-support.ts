import {
  isRegisteredCapabilityProfile,
  matchesRegisteredCapabilityProfileSource,
} from "../source-capability-registry.js";
import type { CapabilityId, CapabilityProfile } from "../source-capability-types.js";
import { sourceSchemaV2EnvelopeFingerprint } from "./schema-envelope.js";
import { schemaStateBindingFingerprint } from "./schema.js";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityAwareSource,
  type Source,
  type SourceDescriptor,
} from "./types.js";

const BUILT_IN_CAPABILITY_IDS: ReadonlySet<string> = new Set(CAPABILITIES);

/** @internal Validate a profile binding and derive its adapter-safe legacy set. */
export function normalizeCapabilityDescriptor(descriptor: SourceDescriptor): SourceDescriptor {
  const profile = descriptor.capabilityProfile;
  if (profile === undefined) return descriptor;
  if (!isRegisteredCapabilityProfile(profile)) {
    throw new TypeError(`Source "${descriptor.id}" capabilityProfile must be evaluated or parsed by this SDK instance`);
  }
  const schemaIdentity =
    descriptor.schemaV2State ??
    (descriptor.schemaV2 === undefined
      ? undefined
      : { state: "known" as const, fingerprint: sourceSchemaV2EnvelopeFingerprint(descriptor.schemaV2) });
  if (schemaIdentity === undefined) {
    throw new TypeError(`Source "${descriptor.id}" capabilityProfile requires a matching schemaV2 identity`);
  }
  if (schemaIdentity.state === "unavailable" && descriptor.schemaV2 !== undefined) {
    throw new TypeError(`Source "${descriptor.id}" unavailable schema state cannot include schemaV2`);
  }
  if (
    schemaIdentity.state === "known" &&
    descriptor.schemaV2 !== undefined &&
    schemaIdentity.fingerprint !== sourceSchemaV2EnvelopeFingerprint(descriptor.schemaV2)
  ) {
    throw new TypeError(`Source "${descriptor.id}" schemaV2State does not match its schemaV2 fingerprint`);
  }
  if (profile.sourceFingerprint !== schemaStateBindingFingerprint(schemaIdentity)) {
    throw new TypeError(`Source "${descriptor.id}" capabilityProfile does not match its schemaV2 fingerprint`);
  }
  if (!matchesRegisteredCapabilityProfileSource(profile, descriptor)) {
    throw new TypeError(`Source "${descriptor.id}" capabilityProfile does not match its endpoint fingerprint`);
  }

  const effectivelySupported = new Set(
    profile.entries.filter((entry) => entry.effective === "supported").map((entry) => entry.id),
  );
  const legacyCapabilities: Capability[] = [];
  for (const capability of CAPABILITIES) {
    if (descriptor.capabilities.has(capability) && effectivelySupported.has(capability)) {
      legacyCapabilities.push(capability);
    }
  }
  if (
    descriptor.capabilities instanceof ImmutableProfileCapabilitySet &&
    descriptor.capabilities.size === legacyCapabilities.length &&
    legacyCapabilities.every((capability) => descriptor.capabilities.has(capability))
  ) {
    return descriptor;
  }
  // The profile is authoritative after admission. Expose a mutation-resistant
  // compatibility view even when its values happen to equal the caller's
  // original Set; otherwise a cast back to Set could silently re-enable an
  // operation after profile validation.
  return { ...descriptor, capabilities: immutableProfileCapabilities(legacyCapabilities) };
}

/** @internal Install one descriptor-authoritative capability view on a source handle. */
export function addCapabilitySupport<T>(source: Source<T>, descriptor: SourceDescriptor): CapabilityAwareSource<T> {
  const profile = descriptor.capabilityProfile;
  const supported =
    profile === undefined
      ? undefined
      : new Set(profile.entries.filter((entry) => entry.effective === "supported").map((entry) => entry.id));
  const supports = ((capability: CapabilityId): boolean => {
    if (typeof capability !== "string") return false;
    if (supported === undefined) {
      return BUILT_IN_CAPABILITY_IDS.has(capability) && descriptor.capabilities.has(capability as Capability);
    }
    if (!supported.has(capability)) return false;
    return !BUILT_IN_CAPABILITY_IDS.has(capability) || descriptor.capabilities.has(capability as Capability);
  }) as CapabilityAwareSource<T>["supports"];

  const members: readonly CapabilityViewMember[] = [
    { key: "descriptor", value: descriptor, enumerable: true },
    { key: "capabilities", value: descriptor.capabilities, enumerable: true },
    { key: "supports", value: supports, enumerable: false },
    ...(profile !== undefined || Object.hasOwn(source, "capabilityProfile")
      ? ([{ key: "capabilityProfile", value: profile, enumerable: false }] as const)
      : []),
  ];
  if (members.every((member) => canInstallCapabilityMember(source, member))) {
    for (const member of members) installCapabilityMember(source, member);
    return source as CapabilityAwareSource<T>;
  }
  return capabilitySupportFacade(source, descriptor, profile, supports);
}

interface CapabilityViewMember {
  readonly key: "descriptor" | "capabilities" | "supports" | "capabilityProfile";
  readonly value: unknown;
  readonly enumerable: boolean;
}

function immutableProfileCapabilities(values: readonly Capability[]): ReadonlySet<Capability> {
  return Object.freeze(new ImmutableProfileCapabilitySet(values));
}

class ImmutableProfileCapabilitySet implements ReadonlySet<Capability> {
  readonly #values: Set<Capability>;

  public constructor(values: readonly Capability[]) {
    this.#values = new Set(values);
  }

  public get size(): number {
    return this.#values.size;
  }

  public has(value: Capability): boolean {
    return this.#values.has(value);
  }

  public entries(): SetIterator<[Capability, Capability]> {
    return this.#values.entries();
  }

  public keys(): SetIterator<Capability> {
    return this.#values.keys();
  }

  public values(): SetIterator<Capability> {
    return this.#values.values();
  }

  public forEach(
    callbackfn: (value: Capability, value2: Capability, set: ReadonlySet<Capability>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  public [Symbol.iterator](): SetIterator<Capability> {
    return this.values();
  }

  public readonly [Symbol.toStringTag] = "Set";
}

function canInstallCapabilityMember(source: object, member: CapabilityViewMember): boolean {
  const current = Object.getOwnPropertyDescriptor(source, member.key);
  if (current && !current.configurable) {
    return "value" in current && current.value === member.value;
  }
  return Object.isExtensible(source) || current !== undefined;
}

function installCapabilityMember(source: object, member: CapabilityViewMember): void {
  const current = Object.getOwnPropertyDescriptor(source, member.key);
  if (current && !current.configurable) return;
  Object.defineProperty(source, member.key, {
    value: member.value,
    configurable: true,
    enumerable: member.enumerable,
    writable: false,
  });
}

function capabilitySupportFacade<T>(
  source: Source<T>,
  descriptor: SourceDescriptor,
  profile: CapabilityProfile | undefined,
  supports: CapabilityAwareSource<T>["supports"],
): CapabilityAwareSource<T> {
  const overrides = new Map<PropertyKey, unknown>([
    ["descriptor", descriptor],
    ["capabilities", descriptor.capabilities],
    ["supports", supports],
    ["capabilityProfile", profile],
  ]);
  const boundMethods = new Map<PropertyKey, unknown>();
  // An empty extensible proxy target avoids invariants from hostile or frozen
  // resolver objects while every forwarded method remains bound to its real
  // receiver (including private-field classes).
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (overrides.has(key)) return overrides.get(key);
      const value = Reflect.get(source as object, key, source as object);
      if (typeof value !== "function") return value;
      const cached = boundMethods.get(key);
      if (cached) return cached;
      const bound = value.bind(source);
      boundMethods.set(key, bound);
      return bound;
    },
    has(_target, key) {
      return overrides.has(key) || Reflect.has(source as object, key);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(source as object);
    },
  }) as CapabilityAwareSource<T>;
}
