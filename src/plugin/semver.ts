interface NumericPrereleaseIdentifier {
  readonly numeric: string;
}

type PrereleaseIdentifier = string | NumericPrereleaseIdentifier;

export type ParsedSemver = readonly [number, number, number, readonly PrereleaseIdentifier[]];

/** Strict, linear-time SemVer parser over ASCII input. */
export function parseSemver(value: string): ParsedSemver | undefined {
  const plus = value.indexOf("+");
  if (plus !== -1 && value.indexOf("+", plus + 1) !== -1) return undefined;
  const versionAndPrerelease = plus === -1 ? value : value.slice(0, plus);
  const build = plus === -1 ? undefined : value.slice(plus + 1);
  if (build !== undefined && !validIdentifiers(build, false)) return undefined;

  const dash = versionAndPrerelease.indexOf("-");
  const coreText = dash === -1 ? versionAndPrerelease : versionAndPrerelease.slice(0, dash);
  const prereleaseText = dash === -1 ? undefined : versionAndPrerelease.slice(dash + 1);
  const coreParts = coreText.split(".");
  if (coreParts.length !== 3) return undefined;
  const core = coreParts.map(parseNumericIdentifier);
  if (core.some((part) => part === undefined)) return undefined;
  if (prereleaseText !== undefined && !validIdentifiers(prereleaseText, true)) return undefined;
  const prerelease = prereleaseText?.split(".").map((part) => (asciiDigits(part) ? { numeric: part } : part)) ?? [];
  return [core[0] as number, core[1] as number, core[2] as number, prerelease];
}

function validIdentifiers(value: string, rejectNumericLeadingZero: boolean): boolean {
  if (value.length === 0) return false;
  for (const part of value.split(".")) {
    if (part.length === 0) return false;
    if (rejectNumericLeadingZero && asciiDigits(part) && part.length > 1 && part[0] === "0") return false;
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      const valid =
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;
      if (!valid) return false;
    }
  }
  return true;
}

function asciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseNumericIdentifier(value: string): number | undefined {
  if (!asciiDigits(value) || (value.length > 1 && value[0] === "0")) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** SemVer precedence using deterministic ASCII identifier ordering. */
export function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] as number) - (right[index] as number);
    if (delta !== 0) return delta;
  }
  const a = left[3];
  const b = right[3];
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index];
    const bv = b[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "object" && typeof bv === "object") {
      const lengthDelta = av.numeric.length - bv.numeric.length;
      if (lengthDelta !== 0) return lengthDelta;
      if (av.numeric !== bv.numeric) return av.numeric < bv.numeric ? -1 : 1;
      continue;
    }
    if (typeof av === "object") return -1;
    if (typeof bv === "object") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}
