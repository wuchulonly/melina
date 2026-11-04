// Markdown 和公式。
//  的结果页、知识报告、工作台上的文字都用这里，不要各自再接一套。
//
// - 解析：marked（GFM：表格、删除线、自动链接），不开 HTML 换行；
// - 公式：$…$、\(…\) 行内，$$…$$、\[…\] 独占一段，KaTeX 渲染（trust 关着，\href、\htmlStyle 之类的不认，颜色只认颜色名和
//   #十六进制）；写错的公式原样显示成代码；
// - 消毒：正文（marked 出来的 HTML）用 DOMPurify，只留 HTML 的安全子集，不许 style 属性、SVG、MathML（外链图片、
//   盖住 Melina 界面的 position:fixed 都靠它们），也不许 id、dialog 和页面自己的 class（借 .toast 之类就能画出假提示）；公式先换成占位，正文消毒完再把 KaTeX 的结果填回去——
//   KaTeX 的排版要用 style，它的输出是 KaTeX 自己从 TeX 生成的，不经过文档作者的 HTML；
// - 链接一律新标签页打开，不带 referrer；图片不从网上拉（可能用来追踪），换成一个写着替代文字的链接；
// - 自动链接到中文标点为止：GFM 的网址一直吃到空白，中文里网址后面常常不空格，
//   「见 http://x/jobs：交一个作业，请求体是配置。」整句会成了链接（href 也错了）。

import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked, Tokenizer, type TokenizerAndRendererExtension, type Tokens } from 'marked';

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: true,
      output: 'htmlAndMathml',
      trust: false,
      strict: 'ignore',
      // 限住尺寸和宏展开：\rule{2000em}{2000em} 能把页面撑到几万像素，宏套宏能卡住页面
      maxSize: 5,
      maxExpand: 100,
    });
  } catch {
    return `<code class="math-error" title="公式写得不对，原样显示">${escapeHtml(tex)}</code>`;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface MathToken extends Tokens.Generic {
  text: string;
}

/** 这一次 renderMarkdown 里渲染好的公式；marked 是同步的，一次渲染内用这个表不会串 */
let formulas: string[] = [];
/** 这一次 renderMarkdown 里标题降几级（同上，一次渲染内有效） */
let headingShift = 0;

function placeholder(html: string, block: boolean): string {
  const i = formulas.push(html) - 1;
  return block ? `<div class="math-block" data-math="${i}"></div>\n` : `<span data-math="${i}"></span>`;
}

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    const i = src.search(/\$\$|\\\[/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src) ?? /^\\\[([\s\S]+?)\\\][ \t]*(?:\n+|$)/.exec(src);
    if (!m) return undefined;
    return { type: 'mathBlock', raw: m[0], text: (m[1] ?? '').trim() } satisfies MathToken;
  },
  renderer(token) {
    return placeholder(renderTex((token as MathToken).text, true), true);
  },
};

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const i = src.search(/\$|\\\(/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    // $…$：开头的 $ 后面不是空白，结尾的 $ 前面不是空白、后面不是数字（免得把「$5 到 $10」当成公式）
    const m = /^\$(?!\$)(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src) ?? /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (!m) return undefined;
    return { type: 'mathInline', raw: m[0], text: m[1] ?? '' } satisfies MathToken;
  },
  renderer(token) {
    return placeholder(renderTex((token as MathToken).text, false), false);
  },
};

/**
 * 网址里不会有、跟在网址后面却很常见的中文标点：，。：；、！？「」『』【】《》“”‘’…—（CJK 标点、全角符号、弯引号）。
 * 汉字本身不算：维基百科这类网址的路径里就是汉字（真任务的库里网址后面直接跟汉字、不带标点的一处都没有，跟标点的上千处）
 */
const CJK_PUNCT = /[\u2014\u2018-\u201f\u2026\u3000-\u303f\uff00-\uff65]/;

/** GFM 自动链接，到第一个中文标点为止；截短以后照原来的规则再认一遍（网址末尾的 .,:; 这类照样不算） */
function urlBeforeCjkPunct(this: Tokenizer, src: string): Tokens.Link | undefined {
  const token = Tokenizer.prototype.url.call(this, src);
  if (!token) return token;
  const cut = token.raw.search(CJK_PUNCT);
  return cut > 0 ? Tokenizer.prototype.url.call(this, token.raw.slice(0, cut)) : token;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  extensions: [mathBlock, mathInline],
  tokenizer: { url: urlBeforeCjkPunct },
  renderer: {
    // 标题整体降级（h1→h2，最低 h6）：页面上已经有一个 h1（任务目标），文档自己的一级标题不能再是 h1
    heading({ tokens, depth }) {
      const level = Math.min(6, depth + headingShift);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    image({ href, title, text }) {
      const label = text || title || '图片';
      return `<a href="${escapeHtml(href)}" class="md-image" title="${escapeHtml(title ?? '图片没有直接显示，点开看')}">［图片：${escapeHtml(label)}］</a>`;
    },
  },
});

/** 文档里只留这几个 class：页面自己的 class（.toast、.drawer……）一旦放行，文档就能画出和 Melina 一样的提示框、按钮骗人点 */
const KEEP_CLASS = /^(?:md-image|math-block|language-[\w-]+)$/;

let hooked = false;
function hookOnce(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'class') return;
    const kept = data.attrValue.split(/\s+/).filter((c) => KEEP_CLASS.test(c));
    if (kept.length > 0) data.attrValue = kept.join(' ');
    else data.keepAttr = false;
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/**
 * 消毒一段不可信的 HTML：只留 HTML 的安全子集，不许 style 属性、SVG、MathML、图片、表单和内嵌页面。
 * 有 DOM 的环境（浏览器）里才能消毒；没有就整段转义成纯文本，不冒险。
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return escapeHtml(html);
  hookOnce();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'style',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'img',
      'picture',
      'source',
      'video',
      'audio',
      'iframe',
      'dialog',
    ],
    // id 能顶替页面上的元素（锚点、表单关联）；background（table、td 的老属性）会去拉外链图片
    FORBID_ATTR: ['style', 'srcset', 'id', 'background'],
    ADD_ATTR: ['target'],
  });
}

const PLACEHOLDER = /<(span|div)( class="math-block")? data-math="(\d+)"><\/\1>/g;

/**
 * Markdown → 消毒过的 HTML（公式是 KaTeX 渲染好的）。headingShift：标题整体降几级（h1→h2，最低 h6），
 * 放进已经有 h1 的页面时用，页面上只留一个 h1
 */
export function renderMarkdown(source: string, options: { headingShift?: number } = {}): string {
  formulas = [];
  headingShift = Math.max(0, Math.floor(options.headingShift ?? 0));
  let html: string;
  try {
    html = marked.parse(source, { async: false });
  } finally {
    headingShift = 0;
  }
  const rendered = formulas;
  formulas = [];
  // 文档里自己写的 <span data-math="…"> 也会被换成某个公式：那也只是 KaTeX 的输出，没有危害
  return sanitizeHtml(html).replace(
    PLACEHOLDER,
    (_, tag: string, cls: string | undefined, i: string) => `<${tag}${cls ?? ''}>${rendered[Number(i)] ?? ''}</${tag}>`,
  );
}
