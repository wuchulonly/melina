import { MelinaError } from './errors.ts';

/** 按最终首屏消息和工具结果的 UTF-8 字节计量；首屏为 60 步摘要及最新状态留空间。 */
export const WATCH_OVERVIEW_BYTES = 48 * 1024;
export const WATCH_DETAIL_BYTES = 8 * 1024;
export const WATCH_HTTP_BYTES = 8 * 1024;
export const WATCH_CORRECTION_BYTES = 8 * 1024;
/** 补查按调用计数，鼓励一次批量查询；提交后另留一次纠错读取。 */
export const WATCH_CONTEXT_CALLS = 3;
export const WATCH_CORRECTION_CALLS = 1;
export const WATCH_SOFT_MS = 100_000;
export const WATCH_HARD_MS = 180_000;
/** 每窗最多 60 步；摘要即可支持判断，原文按需展开。 */
export const WATCH_WINDOW_STEPS = 60;
export const WATCH_WINDOW_BYTES = 80 * 1024;
export const WATCH_STATE_BYTES = 2 * 1024;

export type WatchFailureReason =
  | 'budget'
  | 'validation'
  | 'context'
  | 'provider'
  | 'model'
  | 'storage'
  | 'no_close'
  | 'unknown';

/** 调度按实际失败原因退避；不能拿 breaker=ok 推断供应商没有慢请求。 */
export class WatchFailure extends MelinaError {
  readonly reason: WatchFailureReason;

  constructor(reason: WatchFailureReason, message: string) {
    super('unavailable', message);
    this.reason = reason;
  }
}
