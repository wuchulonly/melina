/** 最大可容纳的文本前缀。fits 必须计入最终序列化的包裹与转义；不切开 UTF-16 代理对。 */
export function fittingPrefix(text: string, fits: (prefix: string) => boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, boundary(text, mid)))) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, boundary(text, low));
}

function boundary(text: string, end: number): number {
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}
