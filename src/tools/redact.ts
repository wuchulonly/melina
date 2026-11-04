// 凭证脱敏：落盘和返回之前，把输出里配置过的凭证值换掉，上下文、Artifact 和日志里都不出现。
// ToolGateway 落盘前调 redact()；容器运行时（container.ts）返回 exec 输出前已经调过一次，再调一次没有副作用。
//
// 要换掉的值是两部分的并集：
// - 设置里现在的凭证（update 换掉）；
// - 已启动的容器手里实际拿着的值（hold，容器删掉时 release）。凭证改了只影响之后启动的容器，
//   老容器里还是旧值，所以旧值要一直换到那个容器删掉为止。
//
// 除了原值，也换掉几种常见的变形：去掉首尾空白的、多行值的每一行、URL 编码的、JSON 字符串里转义过的、base64 的。
// 这只防不小心带出来（curl -v 打出请求头、cat 了凭证文件、kubectl 打出 base64 的 Secret），防不住模型有意绕开。

import type { Redactor, ResolvedCredential } from '../core/interfaces/container.ts';

/** 比这短的值不换：换了会把正常输出改得面目全非（值是 "true"、"1234" 这类） */
export const MIN_SECRET_LENGTH = 6;

/** 一个要换掉的值 */
export interface Secret {
  name: string;
  value: string;
}

export interface SecretRedactorOptions {
  /** 有凭证太短、不会被替换时提醒一次（进系统日志，不进模型上下文） */
  onWarn?: (message: string) => void;
}

export class SecretRedactor implements Redactor {
  readonly #onWarn: (message: string) => void;
  #configured: Secret[] = [];
  readonly #held = new Map<string, Secret[]>();
  readonly #warned = new Set<string>();
  // 按长度从长到短排的全部变形，和它对应的占位符；变了就重建
  #variants: { text: string; placeholder: string }[] = [];
  #matcher: RegExp | undefined;

  constructor(options: SecretRedactorOptions = {}) {
    this.#onWarn = options.onWarn ?? (() => {});
  }

  /** 设置里的凭证改了：换掉 configured 这部分；容器手里的旧值留着，直到容器删掉 */
  update(credentials: readonly ResolvedCredential[]): void {
    this.#configured = credentials.map((c) => ({ name: c.name, value: c.value }));
    this.#rebuild();
  }

  /** 容器启动时登记它手里的凭证值（owner 是容器名） */
  hold(owner: string, secrets: readonly Secret[]): void {
    this.#held.set(owner, [...secrets]);
    this.#rebuild();
  }

  /** 容器删掉了，它手里的值不用再换（设置里还有的照样换） */
  release(owner: string): void {
    if (this.#held.delete(owner)) this.#rebuild();
  }

  redact(text: string): string {
    if (!this.#matcher || text.length === 0) return text;
    return text.replace(this.#matcher, (found) => this.#placeholderOf(found));
  }

  /**
   * 被截断过的输出：开头一段和结尾一段之间省略了内容。截断处可能正好切在一个凭证中间，
   * 所以除了整体替换，还要换掉开头一段末尾的「某个值的前半截」和结尾一段开头的「某个值的后半截」。
   */
  redactCut(head: string, tail: string): { head: string; tail: string } {
    let h = this.redact(head);
    let t = this.redact(tail);
    if (!this.#matcher) return { head: h, tail: t };
    for (const v of this.#variants) {
      h = replacePartialEnd(h, v.text, v.placeholder);
      t = replacePartialStart(t, v.text, v.placeholder);
    }
    return { head: h, tail: t };
  }

  /** 现在要替换的值有几个（测试和状态显示用） */
  get size(): number {
    return this.#variants.length;
  }

  #placeholderOf(found: string): string {
    for (const v of this.#variants) if (v.text === found) return v.placeholder;
    return '[凭证已隐藏]';
  }

  #rebuild(): void {
    const all = [...this.#configured, ...[...this.#held.values()].flat()];
    const byText = new Map<string, string>();
    for (const secret of all) {
      if (secret.value.trim().length < MIN_SECRET_LENGTH) {
        if (secret.value.length > 0 && !this.#warned.has(secret.name)) {
          this.#warned.add(secret.name);
          this.#onWarn(`凭证「${secret.name}」的值太短（少于 ${MIN_SECRET_LENGTH} 个字符），不会从输出里替换掉`);
        }
        continue;
      }
      const placeholder = `[凭证「${secret.name}」已隐藏]`;
      for (const text of variantsOf(secret.value)) if (!byText.has(text)) byText.set(text, placeholder);
    }
    this.#variants = [...byText]
      .map(([text, placeholder]) => ({ text, placeholder }))
      .sort((a, b) => b.text.length - a.text.length);
    // 正则的分支按顺序试，长的放前面，同一处取最长的那个
    this.#matcher =
      this.#variants.length > 0
        ? new RegExp(this.#variants.map((v) => escapeRegExp(v.text)).join('|'), 'g')
        : undefined;
  }
}

/** 一个凭证值要换掉的几种形式，都不短于 MIN_SECRET_LENGTH */
export function variantsOf(value: string): string[] {
  const out = new Set<string>();
  const add = (text: string) => {
    if (text.length >= MIN_SECRET_LENGTH) out.add(text);
  };
  add(value);
  const trimmed = value.trim();
  add(trimmed);
  // 多行的（PEM 私钥、JSON 密钥文件）：只打出其中几行时也要换掉
  if (/[\r\n]/.test(trimmed)) for (const line of trimmed.split(/\r?\n/)) add(line.trim());
  add(encodeURIComponent(trimmed));
  add(JSON.stringify(trimmed).slice(1, -1));
  // 反过来：登记的是 JSON 里转义过的写法（服务账号文件里的 "private_key": "-----BEGIN…\n…"），
  // jq -r 打出来的是解开转义的样子，整段和每一行都换掉
  const unescaped = jsonUnescaped(trimmed);
  if (unescaped !== undefined) {
    add(unescaped.trim());
    for (const line of unescaped.split(/\r?\n/)) add(line.trim());
  }
  for (const encoded of base64Variants(trimmed)) if (encoded.length >= 8) out.add(encoded);
  return [...out];
}

/** 当成 JSON 字符串的内容解开转义；没有转义、或者解不开的返回 undefined */
function jsonUnescaped(value: string): string | undefined {
  if (!/\\[nrt"\\/u]/.test(value)) return undefined;
  try {
    const plain: unknown = JSON.parse(`"${value}"`);
    return typeof plain === 'string' && plain !== value ? plain : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 凭证值出现在一段 base64 里时的样子。凭证前面可能有别的字节（Basic 认证的 `user:TOKEN`、docker config.json 的 auth），
 * base64 三个字节一组，凭证从组里第几个字节开始，编出来就不一样：三种对齐各算一份。
 * 和前后字节拼在同一组里的字符取决于别人，只留完全由凭证决定的整组（标准和 URL 安全两种字母表）。
 */
function base64Variants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const out: string[] = [];
  for (const shift of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const firstGroup = shift === 0 ? 0 : 1; // 第一组混着前面的字节
    const lastGroup = Math.floor((shift + bytes.length) / 3); // 最后不满三个字节的那组混着后面的字节
    if (lastGroup <= firstGroup) continue;
    const stable = encoded.slice(firstGroup * 4, lastGroup * 4);
    out.push(stable);
    const urlSafe = stable.replace(/\+/g, '-').replace(/\//g, '_');
    if (urlSafe !== stable) out.push(urlSafe);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** text 的末尾是 secret 的前半截（至少 MIN_SECRET_LENGTH 个字符）就换掉 */
function replacePartialEnd(text: string, secret: string, placeholder: string): string {
  const max = Math.min(secret.length - 1, text.length);
  const last = text.charCodeAt(text.length - 1);
  for (let k = max; k >= MIN_SECRET_LENGTH; k--) {
    if (secret.charCodeAt(k - 1) !== last) continue;
    if (text.endsWith(secret.slice(0, k))) return text.slice(0, text.length - k) + placeholder;
  }
  return text;
}

/** text 的开头是 secret 的后半截就换掉 */
function replacePartialStart(text: string, secret: string, placeholder: string): string {
  const max = Math.min(secret.length - 1, text.length);
  const first = text.charCodeAt(0);
  for (let k = max; k >= MIN_SECRET_LENGTH; k--) {
    if (secret.charCodeAt(secret.length - k) !== first) continue;
    if (text.startsWith(secret.slice(secret.length - k))) return placeholder + text.slice(k);
  }
  return text;
}
