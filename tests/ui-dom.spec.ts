import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, delegateInput, fatalError, mount } from '../src/ui/dom';

/**
 * 用最小假 DOM 验证 dom.ts 的三条关键行为（项目没有 jsdom）：
 *  - 跨屏重绘回顶部，同屏局部重绘不再跳回顶部（P2 滚动复位）；
 *  - 渲染失败兜底页（无全局 onerror 时代的白屏）；
 *  - 事件委托只认真正的按钮：disabled、无 data-act 的容器都不触发。
 */

type Handler = (event: unknown) => void;

const listeners = new Map<string, Handler[]>();
const scrollCalls: Array<[number, number]> = [];
let appInnerHtml = '';
let bootHidden = false;

const appNode = {
  get innerHTML(): string {
    return appInnerHtml;
  },
  set innerHTML(value: string) {
    appInnerHtml = value;
  },
  dataset: {} as Record<string, string>,
  addEventListener(type: string, handler: Handler): void {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
  },
  contains: (): boolean => true,
};

const bootNode = {
  setAttribute(name: string): void {
    if (name === 'hidden') bootHidden = true;
  },
};

function fire(type: string, event: unknown): void {
  for (const handler of listeners.get(type) ?? []) handler(event);
}

function clickEvent(hit: unknown) {
  return {
    target: { closest: () => hit },
    preventDefault: () => {
      clickEvent.prevented = true;
    },
    stopPropagation: () => {
      clickEvent.stopped = true;
    },
  };
}
clickEvent.prevented = false;
clickEvent.stopped = false;

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => (id === 'app' ? appNode : id === 'boot' ? bootNode : null),
  };
  (globalThis as unknown as { window: unknown }).window = {
    scrollTo: (x: number, y: number) => scrollCalls.push([x, y]),
  };
});

afterAll(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('mount 的滚动策略', () => {
  it('跨屏渲染回到顶部', () => {
    scrollCalls.length = 0;
    mount('<div>home</div>');
    expect(scrollCalls).toEqual([[0, 0]]);
    expect(appInnerHtml).toContain('home');
    expect(bootHidden).toBe(true);
  });

  it('同屏局部重绘保留滚动位置', () => {
    scrollCalls.length = 0;
    mount('<div>same</div>', { keepScroll: true });
    expect(scrollCalls).toEqual([]);
  });
});

describe('fatalError 兜底页', () => {
  it('给出可操作出口，并转义错误文本', () => {
    fatalError('<b>boom</b>');
    expect(appInnerHtml).toContain('界面没能加载出来');
    expect(appInnerHtml).toContain('&lt;b&gt;boom&lt;/b&gt;');
    expect(appInnerHtml).toContain('data-act="load"');
    expect(appInnerHtml).toContain('data-screen="home"');
  });
});

describe('事件委托只认真正的按钮', () => {
  it('disabled 的按钮不触发', () => {
    const calls: string[] = [];
    delegate((act) => calls.push(act));
    const button = { dataset: { act: 'wipe' }, disabled: true };
    fire('click', clickEvent(button));
    expect(calls).toEqual([]);
  });

  it('没有 data-act 的容器（被底栏压住时的命中）不触发', () => {
    const calls: string[] = [];
    delegate((act) => calls.push(act));
    fire('click', clickEvent({ dataset: {}, disabled: false }));
    expect(calls).toEqual([]);
  });

  it('真按钮触发一次并吞掉冒泡', () => {
    const calls: string[] = [];
    delegate((act) => calls.push(act));
    clickEvent.prevented = false;
    clickEvent.stopped = false;
    fire('click', clickEvent({ dataset: { act: 'advance-week' }, disabled: false }));
    expect(calls).toEqual(['advance-week']);
    expect(clickEvent.prevented).toBe(true);
    expect(clickEvent.stopped).toBe(true);
  });

  it('输入框委托带出 data-field 与当前值', () => {
    const seen: Array<[string, string]> = [];
    delegateInput((value, node) => seen.push([String(node.dataset.field), value]));
    const input = { value: '张 三', closest: () => ({ dataset: { field: 'playerName' } }) };
    fire('input', { target: input });
    expect(seen).toEqual([['playerName', '张 三']]);
  });
});
