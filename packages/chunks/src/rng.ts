/**
 * A bit-exact port of CPython's `random.Random` for the calls chunkgen.py
 * makes (seed(int), random(), getrandbits(k <= 32), randint, choice), so a
 * seeded TypeScript chunk equals the Python prototype's chunk for the same
 * seed. MT19937 with CPython's init_by_array seeding.
 *
 * Only non-negative integer seeds up to 2^53 are supported (Python seeds
 * with abs(seed) split into 32-bit words, least significant first).
 */
const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number = 0) {
    this.seed(seed);
  }

  /** random.seed(n) for an integer n (Python uses |n|). */
  seed(seed: number): void {
    if (!Number.isFinite(seed) || !Number.isInteger(seed)) throw new RangeError(`PyRandom seed must be an integer, got ${seed}`);
    let n = Math.abs(seed);
    if (n > Number.MAX_SAFE_INTEGER) throw new RangeError("PyRandom seed must be below 2^53");
    const key: number[] = [];
    if (n === 0) key.push(0);
    while (n > 0) {
      key.push(n % 0x100000000 >>> 0);
      n = Math.floor(n / 0x100000000);
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      // 1812433253 * prev + i, mod 2^32 (split multiply to stay exact).
      mt[i] = (((((prev & 0xffff0000) >>> 16) * 1812433253) << 16) + (prev & 0x0000ffff) * 1812433253 + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] =
        ((mt[i] ^ (((((prev & 0xffff0000) >>> 16) * 1664525) << 16) + (prev & 0x0000ffff) * 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ (((((prev & 0xffff0000) >>> 16) * 1566083941) << 16) + (prev & 0x0000ffff) * 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32. */
  nextUint32(): number {
    const mt = this.mt;
    let y: number;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53-bit float in [0, 1). */
  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** random.getrandbits(k) for 1 <= k <= 32. */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32) throw new RangeError(`getrandbits supports 1..32 bits, got ${k}`);
    return this.nextUint32() >>> (32 - k);
  }

  /** random._randbelow(n) (getrandbits rejection sampling), n >= 1. */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`randbelow needs n >= 1, got ${n}`);
    if (n > 0xffffffff) throw new RangeError("randbelow supports n < 2^32");
    const k = 32 - Math.clz32(n); // n.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** random.randint(a, b), inclusive. */
  randint(a: number, b: number): number {
    if (b < a) throw new RangeError(`empty range for randint(${a}, ${b})`);
    return a + this.randbelow(b - a + 1);
  }

  /** random.choice(seq). */
  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError("Cannot choose from an empty sequence");
    return seq[this.randbelow(seq.length)];
  }
}
