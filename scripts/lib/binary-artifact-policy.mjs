import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATH_PATTERNS = Object.freeze([
  /\.wasm(?:\.(?:br|gz))?$/i,
  /\.duckdb_extension(?:\.(?:br|gz))?$/i,
  /\.(?:class|dll|dylib|exe|jar|node|o|obj|pyc|pyo)$/i,
  /\.(?:a|lib)$/i,
  /\.so(?:\.\d+)*$/i,
]);

const EXECUTABLE_MAGICS = Object.freeze([
  { name: "WebAssembly", bytes: Object.freeze([0x00, 0x61, 0x73, 0x6d]) },
  { name: "ELF", bytes: Object.freeze([0x7f, 0x45, 0x4c, 0x46]) },
  { name: "PE/COFF", bytes: Object.freeze([0x4d, 0x5a]) },
  { name: "Java class", bytes: Object.freeze([0xca, 0xfe, 0xba, 0xbe]) },
  { name: "Mach-O", bytes: Object.freeze([0xfe, 0xed, 0xfa, 0xce]) },
  { name: "Mach-O", bytes: Object.freeze([0xce, 0xfa, 0xed, 0xfe]) },
  { name: "Mach-O 64-bit", bytes: Object.freeze([0xfe, 0xed, 0xfa, 0xcf]) },
  { name: "Mach-O 64-bit", bytes: Object.freeze([0xcf, 0xfa, 0xed, 0xfe]) },
  { name: "Mach-O universal", bytes: Object.freeze([0xca, 0xfe, 0xba, 0xbe]) },
  { name: "Mach-O universal", bytes: Object.freeze([0xbe, 0xba, 0xfe, 0xca]) },
  { name: "Unix archive", bytes: Object.freeze([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]) },
]);

function startsWith(bytes, magic) {
  return bytes.byteLength >= magic.length && magic.every((value, index) => bytes[index] === value);
}

export function forbiddenBinaryArtifactReason(file, prefix = new Uint8Array()) {
  const normalized = file.replaceAll("\\", "/");
  if (FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "filename has a generated executable extension";
  }
  for (const magic of EXECUTABLE_MAGICS) {
    if (startsWith(prefix, magic.bytes)) return `content has ${magic.name} executable magic`;
  }
  return undefined;
}

function readPrefix(file, maximumBytes = 8) {
  const descriptor = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes);
    const byteLength = fs.readSync(descriptor, bytes, 0, maximumBytes, 0);
    return bytes.subarray(0, byteLength);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function scanBinaryArtifactFiles({ root, paths }) {
  const resolvedRoot = path.resolve(root);
  const violations = [];
  for (const file of paths) {
    const absolute = path.resolve(resolvedRoot, file);
    if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
      violations.push({ file, reason: "path escapes the inspected root" });
      continue;
    }
    const pathReason = forbiddenBinaryArtifactReason(file);
    if (pathReason) {
      violations.push({ file, reason: pathReason });
      continue;
    }
    let metadata;
    try {
      metadata = fs.lstatSync(absolute);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) continue;
    const contentReason = forbiddenBinaryArtifactReason(file, readPrefix(absolute));
    if (contentReason) violations.push({ file, reason: contentReason });
  }
  return violations;
}
