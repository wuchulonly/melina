// sh 的配套命令，随调用提供，现有容器无需重建镜像。
// 所有状态与子进程都在调用方容器中；Melina 与单 agent 基线共用 runSh。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { shQuote } from './paths.ts';

const source = readFileSync(new URL('./batch.py', import.meta.url), 'utf8');
const scriptPath = `/tmp/.melina-batch-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.py`;

/** 不包住原命令：保留它的退出码、重定向和 shell 设置；仅在提到 melina-batch 时落地脚本并提供函数。 */
export function withBatchCommand(cmd: string): string {
  if (!cmd.includes('melina-batch')) return cmd;
  return `if [ ! -r ${scriptPath} ]; then (umask 077 && printf %s ${shQuote(source)} > "${scriptPath}.$$" && chmod 0444 "${scriptPath}.$$" && mv -f "${scriptPath}.$$" ${scriptPath}) 2>/dev/null || true; fi
function melina-batch() { python3 ${scriptPath} "$@"; }
export -f melina-batch
${cmd}`;
}
