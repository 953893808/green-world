import { BALANCE } from '../balance';
import type { PlayState, SaveGame, WorldState } from '../types';
import { encodeSave } from './encode';

/**
 * 存档持久化（设计 §11.2）：
 *  - key `greenworld_save_v1`；
 *  - 写入防抖 400ms + 内容去重（同内容不重复写）；
 *  - 存储后端可替换：浏览器 localStorage，测试/Node 用内存实现。
 */

export const SAVE_KEY = 'greenworld_save_v1';

export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 内存后端，供测试与无 localStorage 环境使用 */
export class MemoryStorage implements SaveStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** 在浏览器里取 localStorage，取不到就用内存（file:// 下也不崩） */
export function defaultStorage(): SaveStorage {
  try {
    const candidate = (globalThis as { localStorage?: SaveStorage }).localStorage;
    if (candidate) {
      const probe = '__greenworld_probe__';
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      return candidate;
    }
  } catch {
    // 隐私模式 / 沙箱禁用 storage：降级到内存
  }
  return new MemoryStorage();
}

export function serialize(save: SaveGame): string {
  return JSON.stringify(save);
}

/** 内容指纹：用于写入去重（时间戳不计入，否则每次调用都算“不同”） */
function signatureOf(save: SaveGame): string {
  return JSON.stringify({ seed: save.seed, mode: save.mode, state: save.state, delta: save.delta });
}

export function saveSizeKB(save: SaveGame): number {
  const bytes = new TextEncoder().encode(serialize(save)).length;
  return bytes / 1024;
}

export interface SaveControllerOptions {
  storage?: SaveStorage;
  /** 防抖毫秒，默认走 BALANCE.saveDebounceMs */
  debounceMs?: number;
  now?: () => number;
}

export class SaveController {
  private readonly storage: SaveStorage;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: SaveGame | undefined;
  private lastSignature = '';
  /** 最近一次写入是否超出体积预算（仅提示，不阻断，避免丢进度） */
  overBudget = false;

  constructor(options: SaveControllerOptions = {}) {
    this.storage = options.storage ?? defaultStorage();
    this.debounceMs = options.debounceMs ?? BALANCE.saveDebounceMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** 立刻写一次（跳过防抖），返回写入的存档 */
  writeNow(world: WorldState, state: PlayState): SaveGame {
    // 立刻写会把更旧的 pending 覆盖掉；定时器若不清，稍后还会把旧档写回去
    this.cancelPending();
    const save = encodeSave(world, state, this.now());
    // 超预算只记录标志：UI 侧提示尚未接线（已知债，见修复报告 §6）。
    // 这样至少不会像修复前那样「超限了但没人知道」。
    this.overBudget = !withinBudget(save);
    this.store(save);
    return save;
  }

  private cancelPending(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }

  private store(save: SaveGame): void {
    const signature = signatureOf(save);
    if (signature === this.lastSignature) return;
    this.storage.setItem(SAVE_KEY, serialize(save));
    this.lastSignature = signature;
  }

  /** 防抖写入：同一内容去重 */
  schedule(world: WorldState, state: PlayState): void {
    this.pending = encodeSave(world, state, this.now());
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  flush(): SaveGame | undefined {
    const save = this.pending;
    this.pending = undefined;
    if (!save) return undefined;
    this.store(save);
    return save;
  }

  readRaw(): unknown {
    const payload = this.storage.getItem(SAVE_KEY);
    if (payload === null) return undefined;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
  }

  has(): boolean {
    return this.storage.getItem(SAVE_KEY) !== null;
  }

  clear(): void {
    this.storage.removeItem(SAVE_KEY);
    this.lastSignature = '';
    this.pending = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** 存档体积是否在设计预算（256 KB）内 */
export function withinBudget(save: SaveGame): boolean {
  return saveSizeKB(save) <= BALANCE.saveMaxKB;
}
