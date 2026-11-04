// 假后端的目录树：GET /dirs 补全工作目录、POST /runs 检查工作目录，都按它来。
// 固定的一棵树，不读真文件系统：截图和测试每次都一样。

import type { DirEntry, DirsResponse } from '../../src/core/api.ts';

export const HOME = '/home/me';
/** Melina 的数据目录：不列出来，工作目录在它里面或包含它都拒绝 */
export const DATA_DIR = '/home/me/.melina';

interface Node {
  git?: boolean;
  children?: Record<string, Node>;
}

const repo = (...children: string[]): Node => ({ git: true, children: dirs(...children) });
function dirs(...names: string[]): Record<string, Node> {
  return Object.fromEntries(names.map((n) => [n, {}]));
}

const TREE: Node = {
  children: {
    home: {
      children: {
        me: {
          children: {
            'api-server': repo('src', 'test', 'scripts', 'docs'),
            'legacy-billing': repo('app', 'bin', 'spec'),
            'shop-api': repo('src', 'test'),
            'search-service': repo('src', 'test', 'bench'),
            notes: { children: dirs('2026', 'drafts') },
            papers: { children: { 'fft-lecture': {}, riemann: { git: true, children: dirs('lean', 'notes') } } },
            '.config': { children: dirs('git', 'nvim') },
            '.cache': {},
            '.melina': { children: dirs('workspaces', 'artifacts') },
          },
        },
      },
    },
    opt: { children: { melina: repo('src', 'web', 'docs', 'test') } },
    srv: { children: dirs('www') },
    tmp: {},
  },
};

function lookup(path: string): Node | undefined {
  let node: Node | undefined = TREE;
  for (const part of path.split('/').filter(Boolean)) {
    node = node?.children?.[part];
    if (!node) return undefined;
  }
  return node;
}

/** ~ 展开成 home，去掉末尾的 /（根目录除外） */
export function normalizeDir(input: string): string {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

export function isDir(path: string): boolean {
  return path.startsWith('/') && lookup(path) !== undefined;
}

export function isGitRepo(path: string): boolean {
  return lookup(path)?.git === true;
}

function insideDataDir(path: string): boolean {
  return path === DATA_DIR || path.startsWith(`${DATA_DIR}/`);
}

/** 工作目录在数据目录里，或者包含数据目录：POST /runs 拒绝 */
export function touchesDataDir(path: string): boolean {
  return insideDataDir(path) || DATA_DIR.startsWith(path === '/' ? '/' : `${path}/`);
}

const MAX_ENTRIES = 50;

/**
 * GET /dirs?prefix=：列出前缀所在目录下名字对得上的子目录。
 * 「/home/me/sh」列 /home/me 下以 sh 开头的；「/home/me/」列 /home/me 下全部；隐藏目录只在输入以「.」开头时列；不列数据目录。
 */
export function listDirs(prefix: string, recent: DirEntry[]): DirsResponse {
  const raw = prefix.trim();
  if (!raw) return { entries: [], truncated: false, recent };
  const expanded = raw === '~' ? `${HOME}/` : raw.startsWith('~/') ? HOME + raw.slice(1) : raw;
  if (!expanded.startsWith('/')) return { entries: [], truncated: false, recent };
  const cut = expanded.lastIndexOf('/');
  const dir = cut === 0 ? '/' : expanded.slice(0, cut);
  const partial = expanded.slice(cut + 1);
  const node = lookup(dir);
  const names = Object.keys(node?.children ?? {})
    .filter((name) => (partial.startsWith('.') ? true : !name.startsWith('.')))
    .filter((name) => name.toLowerCase().startsWith(partial.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const entries = names
    .map((name) => {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      return { name, path, git: isGitRepo(path) };
    })
    .filter((e) => !insideDataDir(e.path));
  return {
    dir,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    recent,
  };
}

export function dirEntry(path: string): DirEntry {
  const name = path === '/' ? '/' : (path.split('/').pop() ?? path);
  return { name, path, git: isGitRepo(path) };
}
