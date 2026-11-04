import { fittingPrefix } from './bytes.ts';
import { invalid } from './errors.ts';

/** 明确的文本位置；column 是该行的 UTF-16 偏移，不是会话游标。 */
export interface TextPosition {
  offset: number;
  column: number;
}

/** text 从 offset 行开始，调用方已按 limit 取行。预算由最终序列化结果决定。 */
export function textPage(
  text: string,
  position: TextPosition,
  totalLines: number,
  fits: (page: { text: string; next?: TextPosition }) => boolean,
) {
  const { offset, column } = position;
  const firstLine = text.indexOf('\n');
  const lineLength = firstLine < 0 ? text.length : firstLine;
  if (
    column > lineLength ||
    (column > 0 && /[\uDC00-\uDFFF]/.test(text[column] ?? '') && /[\uD800-\uDBFF]/.test(text[column - 1] ?? ''))
  )
    throw invalid('column 超出起始行或落在 Unicode 字符中间');
  const remaining = text.slice(column);
  const pageOf = (prefix: string) => {
    const lines = prefix.split('\n');
    const next =
      prefix.length < remaining.length
        ? {
            offset: offset + lines.length - 1,
            column: lines.length === 1 ? column + prefix.length : (lines.at(-1)?.length ?? 0),
          }
        : offset + text.split('\n').length <= totalLines
          ? { offset: offset + text.split('\n').length, column: 0 }
          : undefined;
    return { text: prefix, ...(next ? { next } : {}) };
  };
  const prefix = fits(pageOf(remaining)) ? remaining : fittingPrefix(remaining, (value) => fits(pageOf(value)));
  if ((!prefix && remaining) || !fits(pageOf(prefix))) throw invalid('读取预算不足，请减少本次查询的引用数量');
  return { ...position, totalLines, ...pageOf(prefix) };
}
