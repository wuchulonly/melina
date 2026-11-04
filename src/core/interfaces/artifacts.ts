// Artifact store。实现在 src/storage/。
// 按内容寻址：artifacts/<runId>/<sha256 前两位>/<sha256>，句柄即 art://<sha256>，同一个 Run 里相同内容自动去重。
// 先写文件，再在事务里引用句柄，保证不会出现悬空句柄。

import type { Handle, Id } from '../ids.ts';

export interface ArtifactStore {
  /** 写入内容，返回句柄；已有就直接返回 */
  put(runId: Id, content: string | Uint8Array): Promise<Handle>;
  /** 把宿主机上的一个文件放进来（工具的大输出、上传的附件），返回句柄 */
  putFile(runId: Id, path: string): Promise<Handle>;
  has(runId: Id, handle: Handle): Promise<boolean>;
  read(runId: Id, handle: Handle): Promise<Uint8Array>;
  /** 按行读（artifact_read 工具）：offset 从 1 数 */
  readLines(
    runId: Id,
    handle: Handle,
    opts?: { offset?: number; limit?: number },
  ): Promise<{ text: string; totalLines: number }>;
  stat(runId: Id, handle: Handle): Promise<{ size: number } | undefined>;
  /** 宿主机上的文件路径：给容器的 /melina/artifacts 视图和 /melina/materials 挂载用 */
  path(runId: Id, handle: Handle): string;
  /** 复制到另一个 Run（接着做时带上上个任务的附件、知识报告、patch） */
  copy(fromRunId: Id, handle: Handle, toRunId: Id): Promise<Handle>;
  /** DELETE /runs/:id */
  deleteRun(runId: Id): Promise<void>;
}
