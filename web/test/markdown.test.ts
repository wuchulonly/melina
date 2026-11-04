// @vitest-environment jsdom
// Markdown 和公式（src/lib/markdown.ts）：公式能渲染，脚本、事件属性、javascript: 链接、外链图片都去掉。
// DOMPurify 自己的安全性靠上游；这里核对的是 Melina 的配置。

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.ts';

describe('标题', () => {
  it('放进已经有 h1 的页面时整体降一级，最低 h6；不降时照原样', () => {
    const src = '# 报告\n\n## 结论\n\n###### 附注\n';
    const shifted = renderMarkdown(src, { headingShift: 1 });
    expect(shifted).toContain('<h2>报告</h2>');
    expect(shifted).toContain('<h3>结论</h3>');
    expect(shifted).toContain('<h6>附注</h6>');
    expect(shifted).not.toContain('<h1');
    expect(renderMarkdown(src)).toContain('<h1>报告</h1>');
    // 一次的降级不带到下一次
    expect(renderMarkdown('# 再来')).toContain('<h1>再来</h1>');
  });
});

describe('公式', () => {
  it('$…$ 行内、$$…$$ 独占一段，都用 KaTeX 渲染', () => {
    const html = renderMarkdown('长度为 $n$ 的序列\n\n$$\nX_k = \\sum_{j=0}^{n-1} x_j\n$$\n');
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="math-block"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('$$');
  });

  it('\\(…\\) 和 \\[…\\] 也认', () => {
    const html = renderMarkdown('行内 \\(a+b\\)\n\n\\[\nE = mc^2\n\\]\n');
    expect(html.match(/class="katex"/g)?.length).toBe(2);
  });

  it('钱数不当成公式', () => {
    const html = renderMarkdown('花了 $5 到 $10 之间');
    expect(html).not.toContain('katex');
    expect(html).toContain('$5 到 $10');
  });

  it('写错的公式原样显示成代码，不报错', () => {
    const html = renderMarkdown('坏的 $\\frac{1}{$ 公式');
    expect(html).toContain('math-error');
  });

  it('表格里的公式', () => {
    const html = renderMarkdown('| $k$ | $X_k$ |\n| --- | --- |\n| 0 | $10$ |\n');
    expect(html).toContain('<table>');
    expect(html.match(/class="katex"/g)?.length).toBe(3);
  });

  it('\\href 这类会带链接的命令不执行（trust 关着）：标红显示命令本身，不生成链接', () => {
    const html = renderMarkdown('$\\href{javascript:alert(1)}{x}$');
    expect(html).not.toMatch(/<a\s|href=/);
    expect(html).toContain('#cc0000');
  });
});

describe('消毒', () => {
  it('去掉脚本和事件属性', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<b onclick="alert(1)">粗</b>\n\n<img src=x onerror=alert(1)>',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<b>粗</b>');
  });

  it('javascript: 链接去掉；正常链接新标签页打开、不带 referrer', () => {
    const html = renderMarkdown('[坏](javascript:alert(1)) [好](https://example.org)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('图片不直接加载，换成链接', () => {
    const html = renderMarkdown('![架构图](https://example.org/a.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('［图片：架构图］');
  });

  it('不许内联样式表、表单和 iframe', () => {
    const html = renderMarkdown(
      '<style>body{display:none}</style><iframe src="https://x"></iframe><form><input></form>',
    );
    expect(html).not.toMatch(/<style|<iframe|<form|<input/);
  });

  it('代码块原样保留', () => {
    const html = renderMarkdown('```js\nconst a = "<b>";\n```');
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('消毒：样式和 SVG', () => {
  it('正文里的 style 属性去掉（免得盖住 Melina 的界面）', () => {
    const html = renderMarkdown('<p style="position:fixed;inset:0">盖住</p>\n\n<span style="color:red">红</span>');
    expect(html).not.toContain('style=');
    expect(html).toContain('盖住');
  });

  it('SVG 和 MathML 不许写在正文里（SVG 的 image 会拉外链图片）', () => {
    const html = renderMarkdown(
      '<svg><image href="https://example.org/t.png"></image></svg>\n\n<math><mi>x</mi></math>',
    );
    expect(html).not.toMatch(/<svg|<image|<math/);
  });

  it('公式照样排得好：KaTeX 自己的 style 留着', () => {
    const html = renderMarkdown('$$\n\\sqrt{x^2+1}\n$$\n');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('style=');
  });

  it('文档里自己写的占位只会换成公式，不会带进别的东西', () => {
    const html = renderMarkdown('$a$ <span data-math="0"></span> <span data-math="9"></span>');
    expect(html.match(/class="katex"/g)?.length).toBe(2);
    expect(html).not.toContain('data-math');
  });
});
