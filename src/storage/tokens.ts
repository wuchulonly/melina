// 按字符范围粗估 token 数，用于工具输出上限和上下文提示线。
//

// - ASCII（英文、代码、JSON 的标点）：4 个字符算 1 个 token；
// - 其余到 U+2E7F 为止的字符（带音标的拉丁字母、希腊文、西里尔文、常用标点和符号）：2 个算 1 个；
// - CJK 和更靠后的字符（汉字、假名、韩文、全角标点、emoji）：1 个算 1 个。
// 中文按一字一个 token 估，比 DeepSeek（约 0.6）偏多、和 GPT、Claude 的分词器差不多，所以上限不会被低估。

const ASCII_WEIGHT = 0.25;
const MID_WEIGHT = 0.5;
const WIDE_START = 0x2e80;

/** 估一段文字的 token 数，向上取整 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let mid = 0;
  let wide = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) ascii++;
    else if (cp < WIDE_START) mid++;
    else wide++;
  }
  return Math.ceil(ascii * ASCII_WEIGHT + mid * MID_WEIGHT + wide);
}
