// 状态、模式、领域的叫法：给人看的说法，不露内部的英文枚举。

import type { RunListItem } from '../../../src/core/api.ts';
import type { ProviderKeyStatus, ProviderStatus } from '../../../src/core/events.ts';
import type { ModelRef } from '../../../src/core/model-ref.ts';
import type { Role, RunMode, RunStatus } from '../../../src/core/types.ts';
import { clause } from './model-text.ts';

export type Tone = 'accent' | 'amber' | 'green' | 'red' | 'gray';

export interface StatusLook {
  label: string;
  tone: Tone;
  live: boolean;
}

/** 任务状态。收尾中（mode 为 settling）单独说 */
export function runStatusLook(status: RunStatus, mode: RunMode): StatusLook {
  switch (status) {
    case 'running':
      return mode === 'settling'
        ? { label: '收尾中', tone: 'accent', live: true }
        : { label: '进行中', tone: 'accent', live: true };
    // 暂停着时在跑的那一段收尾交了结果，任务照样进收尾（storage/writer.ts 交候选只切 mode）：这时写收尾中，
    // 页头不再一边「已暂停」一边「正在交付结果」
    case 'paused':
      return mode === 'settling'
        ? { label: '收尾中', tone: 'accent', live: true }
        : { label: '已暂停', tone: 'gray', live: false };
    case 'done':
      return { label: '完成了', tone: 'green', live: false };
    case 'cancelled':
      return { label: '已取消', tone: 'gray', live: false };
    case 'failed':
      return { label: '出错停下', tone: 'red', live: false };
  }
}

export function isEnded(status: RunStatus): boolean {
  return status === 'done' || status === 'cancelled' || status === 'failed';
}

/** 运行阶段不推断路线数量；直解可包含多份独立副本与摘要接力。 */
export function modeLabel(mode: RunMode): string {
  switch (mode) {
    case 'direct':
      return '自主探索';
    case 'settling':
      return '交付中';
  }
}

const DOMAIN_LABELS: Record<string, string> = { code: '写代码', research: '调研写作', general: '通用' };

export function domainLabel(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  return DOMAIN_LABELS[domain] ?? domain;
}

export function runningCount(runs: readonly RunListItem[]): number {
  return runs.filter((r) => r.status === 'running').length;
}

export function breakerLook(p: ProviderStatus): StatusLook {
  switch (p.breaker) {
    case 'ok':
      return p.retryAt && Date.parse(p.retryAt) > Date.now()
        ? { label: '被限流', tone: 'amber', live: false }
        : { label: '正常', tone: 'green', live: false };
    case 'open':
      return { label: '熔断中', tone: 'red', live: false };
    case 'probing':
      return { label: '正在试探', tone: 'amber', live: true };
  }
}

/** 一个 API key 的状况 */
export function keyLook(state: ProviderKeyStatus['state']): StatusLook {
  switch (state) {
    case 'active':
      return { label: '在用', tone: 'green', live: false };
    case 'standby':
      return { label: '备用', tone: 'gray', live: false };
    case 'down':
      return { label: '用不了', tone: 'red', live: false };
  }
}

/**
 * 系统状态里一家的 key 怎么说：都好着就不说；
 * 有用不了的，说是哪个、为什么，现在用的是哪个。
 * unreadable 是存着、却解不开的 key（GET /models 里 hasKey 是 false，比如密钥文件换过）：Melina 不会再试它们，
 * 只能到模型页重新填，不说「过一阵再试，好了就换回去」
 */
export function keysNote(
  keys: readonly ProviderKeyStatus[],
  unreadable: ReadonlySet<string> = new Set(),
): string | undefined {
  const name = (k: ProviderKeyStatus) => (k.name ? `「${k.name}」` : `第 ${keys.indexOf(k) + 1} 个`);
  const down = keys.filter((k) => k.state === 'down');
  if (down.length === 0) return undefined;
  const why = down.map((k) => `${name(k)}${k.reason ? `（${clause(k.reason)}）` : ''}`).join('、');
  if (keys.length === 1) return `API key 用不了${down[0]?.reason ? `：${clause(down[0].reason)}` : ''}。`;
  const active = keys.find((k) => k.state === 'active');
  if (!active) return `${keys.length} 个 API key 都用不了：${why}。`;
  const retried = down.some((k) => !unreadable.has(k.id));
  return `API key ${why}用不了，现在用${name(active)}；${
    retried
      ? '过一阵再试，一直不行就隔得越来越久（最长一小时），好了就换回去。'
      : '解不开的 key Melina 不会再试，到模型页重新填好才换回去。'
  }`;
}

/** 按角色展示用量时，将内部角色标识转换为工作台上的用户可读名称。 */
const ROLE_LABELS: Record<Role, string> = {
  explorer: '各条求解路线',
  scoper: '起草完成标准',
  watcher: '巡检主干路线',
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role];
}

/** deepseek/deepseek-flash（和 core 的 modelKey 一样；页面不 import core 的值） */
export function modelName(ref: Pick<ModelRef, 'provider' | 'model'>): string {
  return `${ref.provider}/${ref.model}`;
}

export const FRESH_DIR = '新建的空目录';

/**
 * 工作目录给人看的名字：最后两段（attempt-1/workspace），只写最后一段时好几个任务看起来一样；
 * 上一级是根下的目录或家目录本身时不写它（/opt/melina 写 melina，/home/me/shop-api 写 shop-api）；太长再从中间省略。
 * 没选目录时 Melina 在数据目录下新建一个空目录，以 Run 的 id 命名；
 * 接着做的任务沿用上个任务的目录，所以按「最后一段是 ULID」认，不按「等于自己的 id」认。
 */
export function workspaceLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const last = parts.at(-1) ?? path;
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(last)) return FRESH_DIR;
  const i = parts.length - 2; // 上一级的下标
  const parent = parts[i];
  const home = i === 1 && (parts[0] === 'home' || parts[0] === 'Users');
  return shortPath(parent === undefined || i === 0 || home ? last : `${parent}/${last}`, 40);
}

/**
 * 路径太长时从中间省略：留开头一段和尽量多的结尾几段（/tmp/…/service-easy/melina/0/attempt-1/workspace），
 * 从右边截断时几个目录看起来一样。开头一段也放不下就只留「…/」加结尾；结尾一段本身都放不下时只留它的末尾
 */
export function shortPath(path: string, max = 56): string {
  const len = (s: string) => [...s].length;
  if (len(path) <= max) return path;
  const parts = path.split('/').filter(Boolean);
  const last = parts.at(-1) ?? path;
  const heads = parts.length > 2 ? [`${path.startsWith('/') ? '/' : ''}${parts[0]}/…/`, '…/'] : ['…/'];
  for (const head of heads) {
    if (len(head) + len(last) > max) continue;
    let tail = last;
    for (let i = parts.length - 2; i >= 1; i--) {
      const next = `${parts[i]}/${tail}`;
      if (len(head) + len(next) > max) break;
      tail = next;
    }
    return head + tail;
  }
  const chars = [...last];
  return `…${chars.slice(chars.length - (max - 1)).join('')}`;
}
