// 只认三样：反引号括起来的当代码，像密钥的串单独拿出来打码（点开才显示），记录的编号换成上标的小序号。
//
// 打码只管显示：设计规范 只替换设置里配过的凭证，附件里的 token、密码被模型抄进发现以后，工作台、时间线上就是原文。
// 宁可漏也别把正常内容打掉：只认带固定前缀的 key、Bearer 后面的串、明确叫 secret/password/token 的键值。

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; parts: Array<{ kind: 'text'; text: string } | { kind: 'secret'; text: string }> }
  | { kind: 'secret'; text: string }
  /** 记录的编号：text 是原文里被换掉的那一截（含前面的空格、方括号），n 是这句里第几个不同的编号 */
  | { kind: 'ref'; text: string; id: string; n: number };

/** 带固定前缀的 key：sk-…（OpenAI、DeepSeek、Anthropic）、GitHub、AWS、Slack、JWT */
const PREFIXED =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

/** Bearer 后面的串；键名明确是密钥的键值（"client_secret":"…"、password=…），只打值 */
const VALUED =
  /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})|(["']?)\b((?:client_|api_|app_)?secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key)\b\3(\s*[:=]\s*)(["']?)([^\s"',;{}&\u0080-￿]{6,})/gi;

interface Span {
  start: number;
  end: number;
}

/** 一段文字里像密钥的位置（按出现先后，不重叠） */
export function secretSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(PREFIXED)) spans.push({ start: m.index, end: m.index + m[0].length });
  for (const m of text.matchAll(VALUED)) {
    if (m[2] !== undefined && m[1] !== undefined) {
      const start = m.index + m[1].length;
      spans.push({ start, end: start + m[2].length });
    } else if (m[7] !== undefined) {
      const end = m.index + m[0].length;
      spans.push({ start: end - m[7].length, end });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

function withSecrets(text: string): Array<{ kind: 'text'; text: string } | { kind: 'secret'; text: string }> {
  const out: Array<{ kind: 'text'; text: string } | { kind: 'secret'; text: string }> = [];
  let at = 0;
  for (const s of secretSpans(text)) {
    if (s.start > at) out.push({ kind: 'text', text: text.slice(at, s.start) });
    out.push({ kind: 'secret', text: text.slice(s.start, s.end) });
    at = s.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** 反引号里不跨行、不为空的才算代码；单个落单的反引号照原样留着 */
const CODE = /`([^`\n]+)`/g;

/**
 * 记录的编号（ULID，Melina 的都是 01 开头）：模型写理由时可能把它抄进正文。
 * 主视图把内部编号换成上标的小序号，
 * 指上去看得到编号。前面那个空格一起去掉（序号贴着前面的字），[…]、【…】包着的连括号去掉；代码里的照原样
 */
const REF = / ?(?:\[(01[0-9A-HJKMNP-TV-Z]{24})\]|【(01[0-9A-HJKMNP-TV-Z]{24})】|\b(01[0-9A-HJKMNP-TV-Z]{24})\b)/g;

function withRefs(parts: TextPart[]): TextPart[] {
  const order = new Map<string, number>();
  const out: TextPart[] = [];
  for (const p of parts) {
    if (p.kind !== 'text') {
      out.push(p);
      continue;
    }
    let at = 0;
    for (const m of p.text.matchAll(REF)) {
      const id = m[1] ?? m[2] ?? m[3] ?? '';
      if (m.index > at) out.push({ kind: 'text', text: p.text.slice(at, m.index) });
      const n = order.get(id) ?? order.size + 1;
      order.set(id, n);
      out.push({ kind: 'ref', text: m[0], id, n });
      at = m.index + m[0].length;
    }
    if (at < p.text.length) out.push({ kind: 'text', text: p.text.slice(at) });
  }
  return out;
}

export function splitModelText(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(CODE)) {
    if (m.index > at) out.push(...withSecrets(literalBreaks(text.slice(at, m.index))));
    out.push({ kind: 'code', parts: withSecrets(m[1] ?? '') });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...withSecrets(literalBreaks(text.slice(at))));
  return withRefs(out);
}

/** 中文字和全角标点（含「」『』、、：；） */
const CJK = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
/** 句末、句中的中文标点：后面跟着的「\n」是分段 */
const CJK_STOP = '。！？；：，、」』）…';
const LITERAL_BREAKS = new RegExp(
  `(?<=[${CJK_STOP}])(?:\\\\n)+|(?<=[${CJK}])(?:\\\\n){2,}|(?:\\\\n){2,}(?=[${CJK}])`,
  'g',
);

/**
 * 模型把换行写成了字面的「\n」（JSON 里多转义了一层）：说明文字可能含有「……答案取指数模型。\n\n摆证据。1) ……」，
 * 页面上原样露着两个反斜杠 n。跟在中文标点后面的、连着两个以上又挨着中文的，换成真的换行：分段照留的地方
 * （决策日志、展开的理由）显示成分段，别处和别的换行一样排成一个空格。挨着西文的单个「\n」照原样（「printf '%s\n' LINE」
 * 里的是原文），反引号里的代码不经过这里
 */
export function literalBreaks(text: string): string {
  if (!text.includes('\\n')) return text;
  return text.replace(LITERAL_BREAKS, (m) => '\n'.repeat(m.length / 2));
}

/** 名字最多占几个字宽：中文、全角标点算一个字，西文、数字、半角符号算半个多（0.55），两边的引号也算 */
const NAME_MAX_EM = 12;
const NAME = /[「『][^「」『』\n]{1,30}[」』]/g;
const WIDE = new RegExp(`[${CJK}\\u1100-\\u115f\\u2e80-\\u2fff\\uac00-\\ud7a3]`);

function emWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 1 : 0.55;
  return w;
}

/**
 * 引号里的短名字（路线名「主干直解路线」、『…』）在哪儿：决定卡上「做了什么」「因为……」、箭头上那句这类短句折行时，
 * 名字整个挪到下一行，不拆成两半。真任务的决定卡上常见「给「压｜缩与内存中间态」发了一条指令」
 * 「再开 4 条路一起试，给「最｜直接的做法」……」，路线名被拆开就认不出是哪条。
 * 只认 12 个字宽以内的，长的照常折；正文不用它：中文正文本来就在任意两个字之间折行，硬留名字会让行尾空一截
 */
export function nameSpans(text: string): Array<{ text: string; name: boolean }> {
  const out: Array<{ text: string; name: boolean }> = [];
  let at = 0;
  for (const m of text.matchAll(NAME)) {
    if (emWidth(m[0]) > NAME_MAX_EM) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index), name: false });
    out.push({ text: m[0], name: true });
    at = m.index + m[0].length;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), name: false });
  return out;
}

/**
 * 模型（或服务端）写的一句话，后面要由界面接标点的时候（「标准：怎么核对的」「不能做的：A；B」「原因：……。」）：
 * 先去掉它句末自带的句号、分号、逗号、顿号。不然就是「不含其它任何字符。：od -c…」「返回 bool。；只用标准库」「。。」
 * 。问号、叹号、省略号、右引号、右括号照留，那是句子的一部分
 */
export function clause(text: string): string {
  const t = text.trimEnd();
  if (/(?:\.\.\.|…)$/.test(t)) return t;
  return t.replace(/[。．.；;，,、]+$/u, '');
}

/** 多长的一串不带空格的西文字符算「长串」（路径、函数调用、包名、网址） */
const LONG_RUN = /[!-~]{24,}/g;
/**
 * 长串里哪些字符后面可以折行：前面是字母、数字（「_」「)」「]」后面的「/」「.」也算），后面跟着字母。
 * 跟着数字的不断（「-33289.2」「0.634」「13:42:21」「1,093」断开就读错了），跟着别的符号的不断（「=-」「://」），
 * 开头的「/」「__」后面不断（不让一个斜杠、两条下划线单独留在行尾）
 */
const BREAK_AFTER = /(?<=[A-Za-z0-9])_(?=[A-Za-z])|(?<=[A-Za-z0-9_)\]])[./\\(,=:&?#-](?=[A-Za-z])/g;

/**
 * 长串在哪儿可以折行：二十几个字符连着没有空格时，浏览器把整串挪到下一行，前面的字孤零零留在上一行
 * （窄卡片里的「用」↵「concurrent.futures.ThreadPoolExecutor(max_worker」↵「s=8)」）。在「.」「/」「_」「(」「,」「=」「:」
 * 这些字符后面切开，组件在切口放 <wbr>：一行先排满，断也断在点、斜杠后面。短的、不是西文的照原样，复制出来的字不变
 */
export function softBreaks(text: string): string[] {
  if (text.length < 24) return [text];
  const out: string[] = [];
  let at = 0;
  for (const m of text.matchAll(LONG_RUN)) {
    const run = m[0];
    for (const b of run.matchAll(BREAK_AFTER)) {
      const cut = b.index + 1;
      if (run.length - cut < 4) continue; // 最后三两个字符（扩展名、版本号的尾巴）别单独折到下一行
      out.push(text.slice(at, m.index + cut));
      at = m.index + cut;
    }
  }
  out.push(text.slice(at));
  return out;
}

/** 打码后的样子：留前 4 个字符认得出是哪个，其余换成圆点 */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, Math.min(4, Math.floor(secret.length / 3)))}••••••`;
}
