// Melina 自己的错误。模块之间抛 MelinaError，HTTP 层按 code 换成状态码（api.ts 的 HTTP_STATUS）。

export type ErrorCode =
  | 'invalid' // 参数或记录不合 schema、引用的 id 不存在或看不到
  | 'not_found'
  | 'conflict' // 状态不对：Run 已结束、分支已不在跑、episode 号对不上（迟到写入）、收尾后再提交候选
  | 'forbidden' // 角色不许用这个工具、Host 或 Origin 不对
  | 'unavailable' // 暂时做不了：供应商熔断、磁盘不足
  | 'internal';

export class MelinaError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'MelinaError';
    this.code = code;
    this.details = details;
  }
}

export function isMelinaError(error: unknown): error is MelinaError {
  return error instanceof MelinaError;
}

export const invalid = (message: string, details?: unknown) => new MelinaError('invalid', message, details);
export const notFound = (message: string) => new MelinaError('not_found', message);
export const conflict = (message: string, details?: unknown) => new MelinaError('conflict', message, details);
export const forbidden = (message: string) => new MelinaError('forbidden', message);
