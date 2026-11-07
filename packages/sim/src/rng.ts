// xoshiro128** — small, fast, and its whole state is four uint32s, so it serialises with the park.
export type RngState = [number, number, number, number];

export function seedRng(seed: number): RngState {
  // splitmix32 to spread a single seed over four words.
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const st: RngState = [next(), next(), next(), next()];
  if ((st[0] | st[1] | st[2] | st[3]) === 0) st[0] = 1;
  return st;
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Next uint32. Mutates the state in place. */
export function nextU32(s: RngState): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 11);
  s[0] >>>= 0; s[1] >>>= 0; s[2] >>>= 0; s[3] >>>= 0;
  return result;
}

/** Integer in [0, n). */
export function randInt(s: RngState, n: number): number {
  return n <= 1 ? 0 : nextU32(s) % n;
}

/** Integer in [lo, hi]. */
export function randRange(s: RngState, lo: number, hi: number): number {
  return lo + randInt(s, hi - lo + 1);
}

/** True with probability num/den. */
export function chance(s: RngState, num: number, den: number): boolean {
  return randInt(s, den) < num;
}
