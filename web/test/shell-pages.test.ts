// 外壳和几个页面上的小函数：浏览器标签页的标题、目录名从中间省略、新建任务的草稿和弹窗的地址、用量图的方向键。

import { describe, expect, it } from 'vitest';
import { documentTitle } from '../src/app/App.tsx';
import { closedHref, newTaskHref, newTaskTarget } from '../src/app/new-task.tsx';
import { FRESH_DIR, shortPath, workspaceLabel } from '../src/lib/labels.ts';
import { nextBar } from '../src/pages/overview/DailyBars.tsx';
import { clearDraft, draftKey, readDraft, writeDraft } from '../src/pages/tasks/Composer.tsx';

/** 内存里的 sessionStorage */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, String(v));
    },
  };
}

/** 一碰就抛的 sessionStorage（隐私模式、禁了站点数据） */
function brokenStorage(): Storage {
  const boom = () => {
    throw new Error('SecurityError');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

describe('浏览器标签页的标题', () => {
  it('别的页使用页名和 Melina', () => {
    expect(documentTitle('总览')).toBe('总览 · Melina');
  });

  it('任务页用目标代替「任务」，太长截到 30 字，换行压成空格', () => {
    expect(documentTitle('任务', '把冷启动降到 200 ms')).toBe('把冷启动降到 200 ms · Melina');
    const long = '用附件 api.md 里的账号，算出这个订单服务里 2026 年第三季度下的全部订单一共多少单、总金额多少分';
    const title = documentTitle('任务', long);
    expect(title.startsWith('用附件 api.md 里的账号')).toBe(true);
    expect(title.endsWith('… · Melina')).toBe(true);
    expect([...title.replace(/^\(1\) /, '').replace(/ · Melina$/, '')]).toHaveLength(30);
    expect(documentTitle('任务', '第一行\n\n  第二行  ')).toBe('第一行 第二行 · Melina');
  });

  it('找不到这个任务（列表还没回来）就写「任务」', () => {
    expect(documentTitle('任务', undefined)).toBe('任务 · Melina');
    expect(documentTitle('任务', '   ')).toBe('任务 · Melina');
  });
});

describe('目录名', () => {
  const trial =
    '/tmp/claude-1000/-opt-melina/2ff4b003-c9fa-4cdf-9122-ef7a4fba410e/scratchpad/gate1-a/trials/service-easy/melina/0/attempt-1/workspace';

  it('短的原样', () => {
    expect(shortPath('/home/me/shop-api')).toBe('/home/me/shop-api');
  });

  it('长的从中间省略：留开头一段和尽量多的结尾几段，不超过上限', () => {
    const s = shortPath(trial, 64);
    expect(s).toBe('/tmp/…/gate1-a/trials/service-easy/melina/0/attempt-1/workspace');
    expect([...s].length).toBeLessThanOrEqual(64);
    // 两个只在中间不同的目录省略以后还分得清
    expect(shortPath(trial.replace('service-easy', 'machine-easy'), 64)).not.toBe(s);
  });

  it('开头一段放不下就只留结尾；结尾一段都放不下时只留它的末尾', () => {
    expect(shortPath('/averyveryverylongtopleveldirectoryname/b/c/d', 20)).toBe('…/b/c/d');
    const s = shortPath('/a/b/an-extremely-long-final-directory-name-here', 16);
    expect(s.startsWith('…')).toBe(true);
    expect([...s]).toHaveLength(16);
    expect(s.endsWith('name-here')).toBe(true);
  });

  it('工作目录写最后两段；上一级是根下的目录或家目录本身时只写最后一段', () => {
    expect(workspaceLabel(trial)).toBe('attempt-1/workspace');
    expect(workspaceLabel('/home/me/shop-api')).toBe('shop-api');
    expect(workspaceLabel('/Users/me/shop-api')).toBe('shop-api');
    expect(workspaceLabel('/opt/melina')).toBe('melina');
    expect(workspaceLabel('/home/me/projects/melina')).toBe('projects/melina');
    expect(workspaceLabel('/home/me/.melina/workspaces/01M3QX6NM02CYR3D4N05G3GPFX')).toBe(FRESH_DIR);
  });

  it('两段太长再从中间省略', () => {
    const s = workspaceLabel('/srv/a-really-long-parent-directory-name/and-a-long-project-name');
    expect([...s].length).toBeLessThanOrEqual(40);
    expect(s.endsWith('and-a-long-project-name')).toBe(true);
  });
});

describe('新建任务的草稿', () => {
  it('新建和接着做各存各的', () => {
    expect(draftKey()).toBe('melina:draft:new');
    expect(draftKey(null)).toBe('melina:draft:new');
    expect(draftKey('01M3YDQPFXP01WW5GH6T8G99NN')).toBe('melina:draft:continue:01M3YDQPFXP01WW5GH6T8G99NN');
  });

  it('存了能读回来，提交以后清掉', () => {
    const s = memoryStorage();
    const key = draftKey();
    writeDraft(key, { statement: '把冷启动降到 200 ms', dir: '/home/me/api' }, '', s);
    expect(readDraft(key, s)).toEqual({ statement: '把冷启动降到 200 ms', dir: '/home/me/api' });
    clearDraft(key, s);
    expect(readDraft(key, s)).toBeUndefined();
  });

  it('和打开时一样（预填的目标、没选目录）就不存', () => {
    const s = memoryStorage();
    const key = draftKey('01M3YDQPFXP01WW5GH6T8G99NN');
    writeDraft(key, { statement: '改过的目标', dir: '' }, '帮我验证黎曼猜想', s);
    expect(readDraft(key, s)?.statement).toBe('改过的目标');
    writeDraft(key, { statement: '帮我验证黎曼猜想', dir: '' }, '帮我验证黎曼猜想', s);
    expect(readDraft(key, s)).toBeUndefined();
  });

  it('坏数据、存不进去都不抛', () => {
    const s = memoryStorage();
    s.setItem('melina:draft:new', '{不是 JSON');
    expect(readDraft('melina:draft:new', s)).toBeUndefined();
    s.setItem('melina:draft:new', JSON.stringify({ statement: 3, dir: '/x' }));
    expect(readDraft('melina:draft:new', s)).toEqual({ statement: '', dir: '/x' });
    const broken = brokenStorage();
    expect(() => writeDraft('k', { statement: 'x', dir: '' }, '', broken)).not.toThrow();
    expect(readDraft('k', broken)).toBeUndefined();
    expect(() => clearDraft('k', broken)).not.toThrow();
    expect(readDraft('k', undefined)).toBeUndefined();
  });
});

describe('新建任务弹窗的地址', () => {
  const RUN = '01M3YDQPFXP01WW5GH6T8G99NN';

  it('?new 是新建，?continue= 是接着做；都有时接着做优先，空的 continue 不算', () => {
    expect(newTaskTarget('')).toBeNull();
    expect(newTaskTarget('?evidence=a,b')).toBeNull();
    expect(newTaskTarget('?new')).toEqual({ key: 'new' });
    expect(newTaskTarget('?new=')).toEqual({ key: 'new' });
    expect(newTaskTarget(`?continue=${RUN}`)).toEqual({ key: `continue:${RUN}`, continueFrom: RUN });
    expect(newTaskTarget(`?new&continue=${RUN}`)).toEqual({ key: `continue:${RUN}`, continueFrom: RUN });
    expect(newTaskTarget('?continue=')).toBeNull();
    expect(newTaskTarget('?continue=&new')).toEqual({ key: 'new' });
  });

  it('开：只写查询串，浏览器按当前这一页补全', () => {
    expect(newTaskHref()).toBe('?new');
    expect(newTaskHref(RUN)).toBe(`?continue=${RUN}`);
    expect(newTaskHref('a b&c')).toBe('?continue=a%20b%26c');
    expect(new URL(newTaskHref(RUN), `http://k/runs/${RUN}/result?route=x#ask-1`).href).toBe(
      `http://k/runs/${RUN}/result?continue=${RUN}`,
    );
  });

  it('关：去掉弹窗的参数，别的参数和 #hash 照旧', () => {
    expect(closedHref('/runs', '?new')).toBe('/runs');
    expect(closedHref(`/runs/${RUN}`, `?route=x&continue=${RUN}`, '#ask-1')).toBe(`/runs/${RUN}?route=x#ask-1`);
    expect(closedHref('/', '')).toBe('/');
  });
});

describe('用量图的方向键', () => {
  it('左右一根，Home、End 到头尾，到边上不动，别的键不管', () => {
    expect(nextBar('ArrowLeft', 5, 14)).toBe(4);
    expect(nextBar('ArrowRight', 5, 14)).toBe(6);
    expect(nextBar('ArrowLeft', 0, 14)).toBe(0);
    expect(nextBar('ArrowRight', 13, 14)).toBe(13);
    expect(nextBar('Home', 7, 14)).toBe(0);
    expect(nextBar('End', 2, 14)).toBe(13);
    expect(nextBar('Enter', 2, 14)).toBeNull();
    expect(nextBar('ArrowLeft', 0, 0)).toBeNull();
  });
});
