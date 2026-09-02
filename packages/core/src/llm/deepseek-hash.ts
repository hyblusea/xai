/**
 * DeepSeekHash - WebAssembly-backed PoW solver for DeepSeek's `DeepSeekHashV1`
 * algorithm. Wraps the official `sha3_wasm_bg` module that ships with Chat2API
 * (originally compiled from the same Rust source that DeepSeek uses to verify
 * challenges on the server).
 *
 * We use the WASM directly so the byte ordering and SHA-3 padding exactly
 * match the server-side implementation; reverse-engineering the algorithm
 * in pure JS is error-prone (the answer layout, byte order and even hash
 * pre-image format have to be bit-for-bit identical).
 *
 * When the WASM solver fails (e.g. difficulty exceeds its search range),
 * a pure-JS SHA3-256 fallback kicks in automatically.
 */
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from './crypto-polyfill.js';

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_solve: (
    retptr: number,
    ptr0: number,
    len0: number,
    ptr1: number,
    len1: number,
    difficulty: number,
  ) => void;
  __wbindgen_add_to_stack_pointer: (delta: number) => number;
  __wbindgen_export_0: (size: number, align: number) => number;
}

interface SolveResult {
  status: number;
  value: number;
}

export class DeepSeekHash {
  private wasmInstance: WasmExports;
  private cachedUint8Memory: Uint8Array | null = null;
  private cachedTextEncoder: TextEncoder = new TextEncoder();
  private offset = 0;

  private constructor(wasmInstance: WasmExports) {
    this.wasmInstance = wasmInstance;
  }

  static async load(wasmPath: string): Promise<DeepSeekHash> {
    const buf = await readFile(wasmPath);
    const { instance } = await WebAssembly.instantiate(buf, { wbg: {} });
    return new DeepSeekHash(instance.exports as unknown as WasmExports);
  }

  /**
   * Try to resolve a `file://` URL against the current module location.
   * Returns the absolute filesystem path of the WASM file, falling back to
   * the provided relative path.
   */
  static resolveWasmPath(importMetaUrl: string, relative: string): string {
    try {
      return join(dirname(fileURLToPath(importMetaUrl)), relative);
    } catch {
      return relative;
    }
  }

  private getCachedUint8Memory(): Uint8Array {
    if (
      this.cachedUint8Memory === null ||
      this.cachedUint8Memory.byteLength === 0
    ) {
      this.cachedUint8Memory = new Uint8Array(this.wasmInstance.memory.buffer);
    }
    return this.cachedUint8Memory;
  }

  private encodeString(text: string): { ptr: number; len: number } {
    const encoded = this.cachedTextEncoder.encode(text);
    const ptr = this.wasmInstance.__wbindgen_export_0(encoded.length, 1) >>> 0;
    const memory = this.getCachedUint8Memory();
    memory.subarray(ptr, ptr + encoded.length).set(encoded);
    this.offset = encoded.length;
    return { ptr, len: encoded.length };
  }

  /**
   * Calculate the PoW answer for the given challenge parameters.
   *
   * Returns the answer (u32) when found, or `undefined` if the WASM solver
   * could not locate one in its search range.
   *
   * @param algorithm Must be `DeepSeekHashV1` (the only algorithm DeepSeek
   *                  currently issues).
   * @param challenge The challenge string from the server.
   * @param salt      The salt from the server.
   * @param difficulty Number of leading zero bits required in the SHA-3
   *                   digest.
   * @param expireAt  Unix timestamp (seconds) before which the challenge
   *                  must be solved.
   */
  public calculateHash(
    algorithm: string,
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number,
  ): number | undefined {
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const prefix = `${salt}_${expireAt}_`;

    const retptr = this.wasmInstance.__wbindgen_add_to_stack_pointer(-16);
    try {
      const { ptr: ptr0, len: len0 } = this.encodeString(challenge);
      const { ptr: ptr1, len: len1 } = this.encodeString(prefix);
      this.wasmInstance.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);

      const dataView = new DataView(this.wasmInstance.memory.buffer);
      const status = dataView.getInt32(retptr + 0, true);
      const value = dataView.getFloat64(retptr + 8, true);

      // status !== 0 means a solution was found (0 = no solution in range).
      if (status !== 0) {
        return value;
      }
      return undefined;
    } finally {
      this.wasmInstance.__wbindgen_add_to_stack_pointer(16);
    }
  }
}

/**
 * Pure-JS SHA3-256 PoW fallback solver.
 *
 * DeepSeek's newer challenges use a `difficulty` value that acts as a
 * threshold divisor rather than a leading-zero-bit count.  The WASM solver
 * (compiled for the original bit-count scheme) cannot handle these, so we
 * fall back to a brute-force search in JS.
 *
 * Algorithm:
 *   prefix    = `${salt}_${expireAt}_`
 *   threshold = floor(2^32 / difficulty)
 *   For nonce = 0, 1, 2 …
 *     hash   = SHA3-256( challenge + prefix + nonce.toString() )
 *     value  = first 4 bytes of hash as little-endian uint32
 *     if value < threshold → nonce is the answer
 */
function solveJsFallback(
  challenge: string,
  salt: string,
  difficulty: number,
  expireAt: number,
): number | undefined {
  const prefix = `${salt}_${expireAt}_`;
  const threshold = Math.floor(2 ** 32 / difficulty);
  const maxIterations = 20_000_000; // safety cap

  const t0 = Date.now();
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const data = prefix + nonce;
    const hash = createHash('sha3-256')
      .update(challenge + data)
      .digest();

    // Read first 4 bytes as little-endian uint32.
    const value = hash.readUInt32LE(0);
    if (value < threshold) {
      console.log(
        `[DeepSeekHash] JS fallback solved in ${Date.now() - t0}ms, nonce=${nonce}`,
      );
      return nonce;
    }
  }

  console.warn(
    `[DeepSeekHash] JS fallback exhausted ${maxIterations} iterations in ${Date.now() - t0}ms`,
  );
  return undefined;
}

let cachedInstance: DeepSeekHash | null = null;
let pendingInit: Promise<DeepSeekHash> | null = null;

/**
 * Lazy singleton accessor: loads the WASM module the first time it is
 * requested, then returns the cached instance on subsequent calls.
 */
export async function getDeepSeekHash(wasmPath: string): Promise<DeepSeekHash> {
  if (cachedInstance) return cachedInstance;
  if (!pendingInit) {
    pendingInit = DeepSeekHash.load(wasmPath).then((inst) => {
      cachedInstance = inst;
      return inst;
    });
  }
  return pendingInit;
}

/**
 * High-level solve helper: tries WASM first, falls back to pure JS.
 */
export async function solvePowChallenge(
  algorithm: string,
  challenge: string,
  salt: string,
  difficulty: number,
  expireAt: number,
  wasmPath: string,
): Promise<number | undefined> {
  // Try WASM solver first (fast for legacy bit-count difficulties).
  try {
    const instance = await getDeepSeekHash(wasmPath);
    const answer = instance.calculateHash(algorithm, challenge, salt, difficulty, expireAt);
    if (answer !== undefined) {
      console.log('[DeepSeekHash] WASM solver succeeded');
      return answer;
    }
  } catch (err) {
    console.warn('[DeepSeekHash] WASM solver error:', (err as Error).message);
  }

  // Fallback to pure JS solver (handles new threshold-based difficulty).
  console.log('[DeepSeekHash] Falling back to JS SHA3-256 solver');
  return solveJsFallback(challenge, salt, difficulty, expireAt);
}
