// 确定性随机：同种子 + 同输入 = 同结果。禁止共用一条随机流。
// 每条业务流都用 hash(worldSeed, ...tags) 分流，改一处逻辑不会连锁改变其它结果。

/** 32 位整数混合（mulberry32 种子化） */
function mix32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a 字符串哈希，用于把 id 变成种子 */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (mix32(seed) || 1) >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 浮点 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min, max] 整数 */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 概率判定 */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 从数组中等概率取一个 */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    const v = arr[Math.floor(this.next() * arr.length)];
    if (v === undefined) throw new Error('Rng.pick: index out of range');
    return v;
  }

  /** 洗牌（返回新数组，不改入参） */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  /** 正态分布近似（Box-Muller），用于身价/能力抖动 */
  gauss(mean: number, sd: number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** 由世界种子 + 一串标签派生一条独立随机流 */
export function streamRng(worldSeed: number, ...tags: (string | number)[]): Rng {
  let seed = mix32(worldSeed);
  for (const tag of tags) {
    seed = mix32(seed ^ (typeof tag === 'number' ? mix32(tag) : hashString(tag)));
  }
  return new Rng(seed);
}

/** 泊松采样（Knuth），λ 上限被 clamp 过，循环不会失控 */
export function poisson(rng: Rng, lambda: number): number {
  const l = Math.max(0, Math.min(lambda, 12));
  const limit = Math.exp(-l);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > limit && k < 30);
  return k - 1;
}
