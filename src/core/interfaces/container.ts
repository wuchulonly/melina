// 容器。实现在 src/tools/container.ts 和 redact.ts。
// 每条分支一个常驻容器，跟着分支状态走（启停由 runtime 管，runtime/branch-env.ts；ToolGateway 只在给它的容器里执行）：
// 排队时不建；暂停时停掉，恢复时重新启动同一个容器，装过的东西还在；
// 分支结束就删掉。Scoper 起一个临时容器，用完就删。Linux 上用 rootless Podman。

import type { Id } from '../ids.ts';
import type { ExecContention } from '../types.ts';

/** 凭证的明文，只在启动容器时用（配置存储解密出来） */
export interface ResolvedCredential {
  id: Id;
  name: string;
  as: { env: string } | { file: string };
  value: string;
}

export interface Mount {
  host: string;
  container: string;
  readOnly: boolean;
}

/** 容器里的固定路径 */
export const CONTAINER_PATHS = {
  workspace: '/workspace', // 工作目录
  artifacts: '/melina/artifacts', // 本分支原始输出的只读视图
  materials: '/melina/materials', // 附件，按原文件名只读挂载
  origin: '/melina/origin', // 人选的工作目录原样只读挂进来：被 .gitignore 忽略、没抄进 workspace 的大目录（数据集这类）在这里读
} as const;

export interface ContainerSpec {
  /** 唯一的名字，例如 melina-<runId>-<branchId>；恢复时按它找回容器 */
  name: string;
  /** 用哪个领域的镜像；Scoper、分支和 setup 都按任务领域选择 */
  domain: string;
  /** 挂到 /workspace：Explorer 可写，Scoper 只读。 */
  workspace: Mount;
  /** 宿主机上这条分支的 /melina/artifacts 视图目录，只读挂载 */
  artifactsDir?: string;
  /** 宿主机上的附件目录，只读挂到 /melina/materials */
  materialsDir?: string;
  /**
   * 人选的原始工作目录只读挂到 /melina/origin，供读取被忽略、未复制进 workspace 的大目录。
   * 使用 Melina 创建的空工作目录时不提供此挂载。
   */
  originDir?: string;
  credentials: ResolvedCredential[];
  /** 字节；不给就按 sandbox.memoryMax */
  memoryMax?: number;
  pidsMax?: number;
  labels?: Record<string, string>;
}

export interface ContainerRef {
  id: string;
  name: string;
  /** 所属任务，由容器标签保存；独立容器可以没有。 */
  runId?: Id;
}

export interface ContainerExecRequest {
  /** 交给 bash -lc */
  cmd: string;
  /** 相对 /workspace 的工作目录 */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** 取消时杀掉整个进程组 */
  signal?: AbortSignal;
  /** 后台运行：立即返回 pid 和日志文件路径（最多 sh.maxBackground 个） */
  background?: boolean;
  /** 仅宿主机显式使用：前台成功完成且输出完整时，在脱敏前交给私有接收器；不出现在工具参数里。 */
  capturePrivate?: (output: string) => void;
  /** 可选宿主检查器：仅处理完整成功的前台输出，返回检查后的输出；不能与 capturePrivate 同用。 */
  inspectPrivate?: (output: string) => string;
}

export interface ContainerExecResult {
  exitCode: number | null;
  /** stdout 和 stderr 按到达顺序合在一起，已经替换掉凭证的值 */
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  background?: { pid: number; log: string };
  /**
   * 命令跑的这段时间里，它所在的 cgroup 撞到的资源上限：前台命令前后各读一次计数取增量，
   * scope 照实写（容器自己的，还是几条路线共用的整台机器）。读不到计数、后台命令都不给
   */
  contention?: ExecContention;
}

export interface ContainerRuntime {
  /** 启动时检查各领域的镜像在不在（镜像用 pnpm images 构建，按内容打标签） */
  checkImages(domains: readonly string[]): Promise<{ domain: string; image: string; present: boolean }[]>;
  /** 没有就建；同名同领域的恢复或复用，领域变化时重建（工作区挂载保留） */
  start(spec: ContainerSpec): Promise<ContainerRef>;
  /** 停掉：后台进程随之结束，容器里装的东西还在 */
  stop(ref: ContainerRef): Promise<void>;
  remove(ref: ContainerRef): Promise<void>;
  /** 按名字找回容器（崩溃恢复时重启分支容器） */
  find(name: string): Promise<ContainerRef | undefined>;
  exec(ref: ContainerRef, req: ContainerExecRequest): Promise<ContainerExecResult>;
  // 列还活着的后台进程的 background()  去掉了：只有实现，没有调用方
  /** 临时容器（Scoper 的）：用完调 remove */
  ephemeral(spec: ContainerSpec): Promise<ContainerRef>;
}

/** 落盘和返回之前，把配置过的凭证值替换掉。上下文、Artifact 和日志里都不出现 */
export interface Redactor {
  redact(text: string): string;
  /** 凭证改了以后换一批要替换的值 */
  update(credentials: readonly ResolvedCredential[]): void;
}
