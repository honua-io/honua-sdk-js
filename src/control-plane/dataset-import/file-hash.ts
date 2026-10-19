/** Whole-file SHA-256 with bounded reads; no upload or task is created by hashing. */
export interface DatasetImportFileHashOptions {
  readonly signal?: AbortSignal;
  /** Defaults to 1 MiB; bounded to 64 KiB–8 MiB. */
  readonly chunkBytes?: number;
  readonly onProgress?: (hashedBytes: number, totalBytes: number) => void;
}

/**
 * Hash every byte before creating a resumable intent, including when resuming a
 * reselected file. Names, timestamps and accepted-prefix hashes are insufficient.
 * Reads slices sequentially so browser memory does not grow with file size.
 */
export async function hashDatasetImportFile(file: Blob, options: DatasetImportFileHashOptions = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 65536 || chunkBytes > 8 * 1024 * 1024)
    throw new RangeError("chunkBytes must be an integer between 64 KiB and 8 MiB.");
  if (!Number.isSafeInteger(file.size) || file.size < 0)
    throw new RangeError("File size must be a nonnegative safe integer.");
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const block = new Uint8Array(64);
  let buffered = 0;
  const consume = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) {
      if (buffered === 0 && bytes.length - offset >= 64) {
        compress(state, words, bytes.subarray(offset, offset + 64));
        offset += 64;
        continue;
      }
      const count = Math.min(64 - buffered, bytes.length - offset);
      block.set(bytes.subarray(offset, offset + count), buffered);
      offset += count;
      buffered += count;
      if (buffered === 64) {
        compress(state, words, block);
        buffered = 0;
      }
    }
  };
  options.signal?.throwIfAborted();
  options.onProgress?.(0, file.size);
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const expected = Math.min(chunkBytes, file.size - offset);
    const slice = file.slice(offset, offset + expected);
    if (slice.size !== expected) throw new Error("File slice length changed during hashing.");
    const bytes = new Uint8Array(await slice.arrayBuffer());
    options.signal?.throwIfAborted();
    if (bytes.length !== expected) throw new Error("File read was truncated or exceeded its declared length.");
    consume(bytes);
    options.onProgress?.(offset + bytes.length, file.size);
  }
  options.signal?.throwIfAborted();
  // SHA-256 encodes the full 64-bit bit length, including files over 512 MiB.
  const padding = new Uint8Array(buffered < 56 ? 64 - buffered : 128 - buffered);
  padding[0] = 0x80;
  const length = new DataView(padding.buffer);
  length.setUint32(padding.length - 8, Math.floor(file.size / 0x20000000), false);
  length.setUint32(padding.length - 4, (file.size % 0x20000000) * 8, false);
  consume(padding);
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function compress(state: Uint32Array, words: Uint32Array, block: Uint8Array): void {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4, false);
  for (let index = 16; index < 64; index++) {
    const before15 = words[index - 15] ?? 0;
    const before2 = words[index - 2] ?? 0;
    const s0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
    const s1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
    words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
  }

  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;
  for (let index = 0; index < 64; index++) {
    const upper1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + upper1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
    const upper0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (upper0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  state[0] = ((state[0] ?? 0) + a) >>> 0;
  state[1] = ((state[1] ?? 0) + b) >>> 0;
  state[2] = ((state[2] ?? 0) + c) >>> 0;
  state[3] = ((state[3] ?? 0) + d) >>> 0;
  state[4] = ((state[4] ?? 0) + e) >>> 0;
  state[5] = ((state[5] ?? 0) + f) >>> 0;
  state[6] = ((state[6] ?? 0) + g) >>> 0;
  state[7] = ((state[7] ?? 0) + h) >>> 0;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
