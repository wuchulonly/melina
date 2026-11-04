// 检查交付时跑代码的地方（代码题的隐藏测试，「两边用同一套检查」）。
// - containerSandbox：跑分时用，和 Melina 一样的容器运行时（开发机是 test/dev 的 proot，不给网络；装了 Podman 的机器是 Podman）。
//   交付是 agent 写的代码，不在宿主机上直接跑。
// - hostSandbox：只给可信的代码用（标准解、起点代码），验证题目本身和单元测试里用，直接在宿主机上跑 bash。

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CONTAINER_PATHS, type ContainerRuntime } from '../../src/core/interfaces/container.ts';
import type { Sandbox } from './task.ts';

/**
 * 命令开头先打的一行：输出里没有它，就是沙箱没把命令跑起来（proot 起不来时返回 127、不抛错，容器 exec 失败），
 * 抛错让跑分记成出错，不当成交付没过
 */
export const SANDBOX_STARTED = 'MELINA_CHECK_STARTED';

/** 每次检查起一个新的临时容器：挂上这份交付的拷贝（可写），跑完就删 */
export function containerSandbox(runtime: Pick<ContainerRuntime, 'start' | 'exec' | 'remove'>): Sandbox {
  return async (dir, cmd, opts) => {
    const ref = await runtime.start({
      name: `melina-eval-check-${randomBytes(6).toString('hex')}`,
      domain: opts.domain,
      workspace: { host: dir, container: CONTAINER_PATHS.workspace, readOnly: false },
      credentials: [],
    });
    try {
      const r = await runtime.exec(ref, { cmd: `echo ${SANDBOX_STARTED}; ${cmd}`, timeoutMs: opts.timeoutMs });
      const at = r.output.indexOf(`${SANDBOX_STARTED}\n`);
      if (at < 0) {
        throw new Error(`检查用的沙箱没把命令跑起来（退出码 ${r.exitCode}）：${r.output.trim().slice(-300)}`);
      }
      return {
        exitCode: r.exitCode,
        output: r.output.slice(at + SANDBOX_STARTED.length + 1),
        timedOut: r.timedOut,
      };
    } finally {
      await runtime.remove(ref).catch(() => {});
    }
  };
}

/** 在宿主机上直接跑（只给可信的代码）：工作目录是 dir，环境变量只留 PATH、HOME、LANG */
export const hostSandbox: Sandbox = (dir, cmd, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let timedOut = false;
    const take = (b: Buffer) => {
      if (output.length < 4 * 1024 * 1024) output += b.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });
