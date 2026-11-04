// 像密钥的串打码、点一下才显示，抄进正文的记录编号换成上标的小序号（lib/model-text.ts）。不当 Markdown，也不做 innerHTML。

import { type ReactNode, useMemo, useState } from 'react';
import { maskSecret, nameSpans, softBreaks, splitModelText, type TextPart } from '../lib/model-text.ts';

/** 每一段在原句里从第几个字符开始：同一句话切出来的段顺序固定，拿它当 key */
function withOffsets<T>(parts: readonly T[], size: (p: T) => number): [number, T][] {
  let at = 0;
  return parts.map((p) => {
    const start = at;
    at += size(p);
    return [start, p];
  });
}

const sizeOf = (p: TextPart): number =>
  p.kind === 'code' ? p.parts.reduce((n, q) => n + q.text.length, 2) : p.text.length;

/** 一段字：长串（路径、函数调用）在点、斜杠这些字符后面放 <wbr>，窄卡片里一行先排满（lib/model-text.ts softBreaks） */
function breakable(text: string): ReactNode {
  const pieces = softBreaks(text);
  if (pieces.length === 1) return text;
  // 切口在原句里第几个字符：同一句话切出来的位置固定，拿它当 key
  let at = 0;
  return pieces.flatMap((s) => {
    const start = at;
    at += s.length;
    return start === 0 ? [s] : [<wbr key={start} />, s];
  });
}

/**
 * 一段字里引号括着的短名字（「主干直解路线」）不拆到两行（lib/model-text.ts nameSpans）：给决定卡「做了什么」、
 * 箭头上那句这类短句用，正文不用。名字在 .name-keep 里不折行，别的照常（长串照样在点、斜杠后面能折）
 */
function named(text: string, rest: (text: string) => ReactNode): ReactNode {
  const spans = nameSpans(text);
  if (spans.length === 1 && !spans[0]?.name) return rest(text);
  return withOffsets(spans, (s) => s.text.length).map(([at, s]) =>
    s.name ? (
      <span key={at} className="name-keep">
        {s.text}
      </span>
    ) : (
      <span key={at}>{rest(s.text)}</span>
    ),
  );
}

export function ModelText({ text, names = false }: { text: string; names?: boolean }) {
  const parts = useMemo(() => withOffsets(splitModelText(text), sizeOf), [text]);
  const plain = names ? (t: string) => named(t, breakable) : breakable;
  // 只有一段字：原文里字面的「\n」已经换成了换行（lib/model-text.ts literalBreaks），用拆出来的这段
  const only = parts.length === 1 ? parts[0]?.[1] : undefined;
  if (only?.kind === 'text') return <>{plain(only.text)}</>;
  return (
    <>
      {parts.map(([at, p]) => {
        if (p.kind === 'text') return <span key={at}>{plain(p.text)}</span>;
        if (p.kind === 'secret') return <Secret key={at} value={p.text} />;
        // 记录的编号：上标的小序号，指上去看编号（主视图不露内部编号）
        if (p.kind === 'ref')
          return (
            <sup key={at} className="ref-mark" title={`记录的编号：${p.id}`}>
              {p.n}
            </sup>
          );
        return (
          <code key={at} className="inline-code">
            {withOffsets(p.parts, (q) => q.text.length).map(([inner, q]) =>
              q.kind === 'secret' ? (
                <Secret key={inner} value={q.text} />
              ) : (
                <span key={inner}>{breakable(q.text)}</span>
              ),
            )}
          </code>
        );
      })}
    </>
  );
}

function Secret({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      className="secret"
      aria-pressed={shown}
      aria-label={shown ? `${value}（点一下遮住）` : '疑似密钥，已遮住，点一下显示'}
      title={shown ? '点一下遮住' : '疑似密钥，点一下显示'}
      onClick={() => setShown((v) => !v)}
    >
      {shown ? value : maskSecret(value)}
    </button>
  );
}
