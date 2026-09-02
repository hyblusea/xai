/**
 * Crypto polyfills for ESM-bundled environments where Node.js `crypto`
 * cannot be statically imported (esbuild/tsup emit "Dynamic require of
 * crypto is not supported").
 *
 * - `randomUUID()`: Uses `crypto.randomUUID()` (available in Node 19+,
 *   Electron 28+, and all modern browsers) with a Math.random fallback.
 * - `createHash()`: Returns a minimal Hash-like object backed by the
 *   Web Crypto API (SubtleCrypto).  Supports 'md5', 'sha1', 'sha256',
 *   and 'sha3-256'.
 */

/* ---------- randomUUID ---------- */

export function randomUUID(): string {
  // Node 19+ / Electron 28+ / browsers expose crypto.randomUUID()
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: v4 UUID via Math.random
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ---------- createHash ---------- */

export interface Hash {
  update(data: string | Buffer): Hash;
  digest(encoding?: string): Buffer | string;
}

const ALGO_MAP: Record<string, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  'sha3-256': 'SHA3-256',
};

export function createHash(algorithm: string): Hash {
  const subtleAlgo = ALGO_MAP[algorithm.toLowerCase()];
  if (!subtleAlgo) {
    throw new Error(`createHash: unsupported algorithm "${algorithm}"`);
  }

  const chunks: Uint8Array[] = [];

  const h: Hash = {
    update(data: string | Buffer) {
      if (typeof data === 'string') {
        chunks.push(new TextEncoder().encode(data));
      } else {
        chunks.push(new Uint8Array(data));
      }
      return h;
    },
    digest(encoding?: string): Buffer | string {
      // Synchronous digest is required by the Node.js Hash interface.
      // Since SubtleCrypto is async, we use a pure-JS fallback for the
      // algorithms we need.
      const combined = combineChunks(chunks);
      const result = syncDigest(algorithm.toLowerCase(), combined);
      if (encoding === 'hex') return bufferToHex(result);
      if (encoding === 'base64') return Buffer.from(result).toString('base64');
      return Buffer.from(result);
    },
  };

  return h;
}

function combineChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Synchronous pure-JS digest implementations for the algorithms we need.
 * These are only used as fallbacks when the Node.js `crypto` module is
 * unavailable (ESM bundle context).
 */
function syncDigest(algo: string, data: Uint8Array): Uint8Array {
  switch (algo) {
    case 'md5':
      return md5Digest(data);
    case 'sha1':
      return sha1Digest(data);
    case 'sha256':
      return sha256Digest(data);
    case 'sha3-256':
      return sha3_256Digest(data);
    default:
      throw new Error(`syncDigest: unsupported algorithm "${algo}"`);
  }
}

/* ---- MD5 ---- */
function md5Digest(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, data.length * 8, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const M = new Uint32Array(padded.buffer, chunk, 16);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, a0, true); rv.setUint32(4, b0, true); rv.setUint32(8, c0, true); rv.setUint32(12, d0, true);
  return result;
}

/* ---- SHA-1 ---- */
function sha1Digest(data: Uint8Array): Uint8Array {
  const len = data.length;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(len * 8 / 0x100000000), false);
  dv.setUint32(paddedLen - 4, len * 8, false);

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;

  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const result = new Uint8Array(20);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false); rv.setUint32(8, h2, false);
  rv.setUint32(12, h3, false); rv.setUint32(16, h4, false);
  return result;
}

/* ---- SHA-256 ---- */
function sha256Digest(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const len = data.length;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(len * 8 / 0x100000000), false);
  dv.setUint32(paddedLen - 4, len * 8, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i-15] >>> 7) | (w[i-15] << 25)) ^ ((w[i-15] >>> 18) | (w[i-15] << 14)) ^ (w[i-15] >>> 3);
      const s1 = ((w[i-2] >>> 17) | (w[i-2] << 15)) ^ ((w[i-2] >>> 19) | (w[i-2] << 13)) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false); rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false); rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}

/* ---- SHA3-256 (Keccak) ---- */
function sha3_256Digest(data: Uint8Array): Uint8Array {
  const rate = 200 - (256 / 4); // rate = 136 bytes
  const suffix = 0x06; // SHA3 suffix

  // Padding
  const paddedLen = Math.ceil((data.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] ^= suffix;
  padded[paddedLen - 1] ^= 0x80;

  // Keccak state (5x5x64 bits = 200 bytes)
  const s = new Uint8Array(200);

  // Absorb
  for (let offset = 0; offset < paddedLen; offset += rate) {
    for (let i = 0; i < rate; i++) s[i] ^= padded[offset + i];
    keccakF1600(s);
  }

  // Squeeze (only one block needed for SHA3-256)
  return s.slice(0, 32);
}

function keccakF1600(state: Uint8Array): void {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
    0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000818An, 0x0000000000008018n, 0x0000000080008001n, 0x800000000000808Bn,
    0x8000000000000001n, 0x8000000080008008n,
  ];

  const ROT = [
    [0,1,62,28,27],[36,44,6,55,20],[3,10,43,25,39],[41,45,15,21,8],[18,2,61,56,14],
  ];

  // Load state into 5x5 BigInt64Array
  const A: bigint[][] = [];
  const dv = new DataView(state.buffer, state.byteOffset, 200);
  for (let y = 0; y < 5; y++) {
    A[y] = [];
    for (let x = 0; x < 5; x++) {
      A[y][x] = dv.getBigUint64((5 * y + x) * 8, true);
    }
  }

  for (let round = 0; round < 24; round++) {
    // θ
    const C: bigint[] = [];
    for (let x = 0; x < 5; x++) C[x] = A[0][x] ^ A[1][x] ^ A[2][x] ^ A[3][x] ^ A[4][x];
    const D: bigint[] = [];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ ((C[(x + 1) % 5] << 1n) | (C[(x + 1) % 5] >> 63n));
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) A[y][x] ^= D[x];

    // ρ and π
    const B: bigint[][] = Array.from({ length: 5 }, () => Array(5).fill(0n));
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const r = BigInt(ROT[y][x]);
      B[(2 * x + 3 * y) % 5][y] = ((A[y][x] << r) | (A[y][x] >> (64n - r))) & 0xFFFFFFFFFFFFFFFFn;
    }

    // χ
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      A[y][x] = B[y][x] ^ ((~B[y][(x + 1) % 5]) & B[y][(x + 2) % 5]);
    }

    // ι
    A[0][0] ^= RC[round];
  }

  // Write back
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    dv.setBigUint64((5 * y + x) * 8, A[y][x], true);
  }
}
