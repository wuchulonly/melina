// 设置页凭证的草稿：在页面上改，点保存才 PUT /settings。
// 值只写：GET 只回 hasValue；PUT 不带 value 就保留原值，传空串就清掉。
// 保存前先拿最新的：页面打开以后别处（另一个标签页、API）改过的，按三方合并留下来，不被这次保存盖掉。

import type { Credential, Settings } from '../../../../src/core/config.ts';

export interface CredentialDraft {
  id?: string;
  name: string;
  as: Credential['as'];
  hasValue: boolean;
  newValue?: string;
  dropValue?: boolean;
  /** React 的 key：存过的用 id，页面上新加的另起一个 */
  local: string;
}

export function credentialDrafts(settings: Settings): CredentialDraft[] {
  return settings.credentials.map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    name: c.name,
    as: c.as,
    hasValue: c.hasValue ?? false,
    local: c.id ?? c.name,
  }));
}

/** 要 PUT 的凭证：值只在改了的时候带 */
export function toCredentials(list: readonly CredentialDraft[]): Credential[] {
  return list.map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    name: c.name,
    as: c.as,
    ...(c.newValue ? { value: c.newValue } : c.dropValue ? { value: '' } : {}),
  }));
}

export function sameCredentials(a: readonly CredentialDraft[], b: readonly CredentialDraft[]): boolean {
  return JSON.stringify(toCredentials(a)) === JSON.stringify(toCredentials(b));
}

function touched(d: CredentialDraft, base: CredentialDraft | undefined): boolean {
  return (
    Boolean(d.newValue) ||
    Boolean(d.dropValue) ||
    !base ||
    d.name !== base.name ||
    JSON.stringify(d.as) !== JSON.stringify(base.as)
  );
}

/**
 * 三方合并：base 是页面打开时的，draft 是这里改过的，fresh 是现在 Melina 那边的。
 * 这里没动的条目取最新的；这里删掉的照删；别处新加的留下；别处删掉、这里又改过的当新的一条加回去。
 */
export function mergeCredentials(
  base: readonly CredentialDraft[],
  draft: readonly CredentialDraft[],
  fresh: readonly CredentialDraft[],
): CredentialDraft[] {
  const baseById = new Map(base.flatMap((c) => (c.id ? [[c.id, c] as const] : [])));
  const freshById = new Map(fresh.flatMap((c) => (c.id ? [[c.id, c] as const] : [])));
  const inDraft = new Set(draft.flatMap((c) => (c.id ? [c.id] : [])));
  const out: CredentialDraft[] = [];
  for (const d of draft) {
    if (!d.id) {
      out.push(d);
      continue;
    }
    const b = baseById.get(d.id);
    const f = freshById.get(d.id);
    if (!f) {
      if (touched(d, b)) {
        const { id: _gone, ...rest } = d;
        out.push({ ...rest, hasValue: false });
      }
      continue;
    }
    out.push(touched(d, b) ? { ...d, hasValue: f.hasValue } : f);
  }
  for (const f of fresh) if (f.id && !baseById.has(f.id) && !inDraft.has(f.id)) out.push(f);
  return out;
}
