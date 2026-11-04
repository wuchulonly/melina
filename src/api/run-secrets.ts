// 开跑前把这个任务的工作目录和附件里原有的密钥登记进打码表：
// - git 仓库：被 .gitignore 忽略、开跑时抄进 <dataDir>/<runId>/local/ 的小文件（.env、本地配置，workspace/local-files.ts）；
// - 普通目录：整个复制进 workspace，按文件名挑像放密钥的（.env、*.pem、credentials……）；
// - 附件：每一个都看（不超过 1 MiB、不是二进制的）。
// 值按 tools/secret-scan.ts 的规则认，以 run:<runId> 为持有者登记进 SecretRedactor（和容器手里的凭证一样 hold、release），
// 模型看到的工具输出里换成「[凭证「.env 里的 API_TOKEN」已隐藏]」，文件本身不动，程序照常能读。
// 准备时登记，Melina 重启后恢复流程重新登记（打码表只在内存里），任务结束、删除时撤掉。
//
// 交付前（runtime 收尾时）：候选相对起点的 patch 里有没有密钥。新建的文件按 createdFileSecretsIn 认
// （.env 这类全部规则，测试、样例数据只认一眼就是的，别的按键名认的值还得像随机串），
// 加上「名字像放 token 的文件、整段是一个随机串」；改了的老文件只认一眼就是的（私钥块、固定前缀的 token、URL 口令）；
// 不管新老，打码表里登记过的值（设置里的凭证、容器手里的、上面登记的）出现了也算。只回在哪儿、是什么，不回值。

import { join } from 'node:path';
import type { Id } from '../core/ids.ts';
import type { ArtifactStore } from '../core/interfaces/artifacts.ts';
import type { Run } from '../core/types.ts';
import type { Secret, SecretRedactor } from '../tools/redact.ts';
import {
  addedInPatch,
  createdFileSecretsIn,
  obviousSecretsIn,
  secretFilesUnder,
  secretsInFile,
  tokenFileSecret,
} from '../tools/secret-scan.ts';
import { runPaths } from '../workspace/layout.ts';
import { readManifest } from '../workspace/local-files.ts';

export interface RunSecrets {
  /** 找出这个任务的工作目录和附件里像密钥的值，登记进打码表；返回登记了几个 */
  add(run: Run): Promise<number>;
  /** 任务结束、删除：撤掉 */
  drop(runId: Id): void;
  /** 交付的 patch（git 格式）里像密钥的东西在哪：「.token 的整段内容」「probe.sh 里的 TOKEN」；没有是空数组 */
  leaksIn(patch: string): string[];
}

export interface RunSecretsDeps {
  /** 放 workspace 的目录（MelinaPaths.dataDir） */
  dataDir: string;
  artifacts: Pick<ArtifactStore, 'path'>;
  redactor: Pick<SecretRedactor, 'hold' | 'release' | 'redact'>;
}

/** 打码表换上的占位符：「[凭证「名字」已隐藏]」（tools/redact.ts） */
const PLACEHOLDER = /\[凭证「([^」]+)」已隐藏\]/g;

export function runSecrets(deps: RunSecretsDeps): RunSecrets {
  return {
    async add(run) {
      const found: Secret[] = [];
      if (run.workspace.kind === 'git-clone') {
        const paths = runPaths(deps.dataDir, run.id);
        const manifest = await readManifest(paths.dir);
        for (const rel of manifest.files) found.push(...(await secretsInFile(join(paths.local, rel), rel)));
        // 人选的仓库原样只读挂在 /melina/origin，原件的 .git/config 也在：workspace 里的克隆去掉了远端地址里的口令，
        // 原件没去。worktree 的 .git 是个文件，原件在挂载外面，读不到就是没有
        found.push(...(await secretsInFile(join(run.workspace.root, '.git', 'config'), '.git/config')));
      } else {
        // 没选工作目录时 Melina 建的空目录（<dataDir>/empty/<runId>）里什么都没有，照样扫一遍也很快
        const root = run.workspace.root;
        for (const rel of await secretFilesUnder(root)) found.push(...(await secretsInFile(join(root, rel), rel)));
      }
      for (const m of run.goal.materials) {
        found.push(...(await secretsInFile(deps.artifacts.path(run.id, m.handle), `附件 ${m.name}`)));
      }
      deps.redactor.hold(ownerOf(run.id), found);
      return found.length;
    },
    drop(runId) {
      deps.redactor.release(ownerOf(runId));
    },
    leaksIn(patch) {
      const out = new Set<string>();
      for (const f of addedInPatch(patch)) {
        const found: Secret[] = f.created ? createdFileSecretsIn(f.added, f.path) : obviousSecretsIn(f.added, f.path);
        const whole = f.created ? tokenFileSecret(f.path, f.added) : undefined;
        if (whole) found.push(whole);
        for (const s of found) out.add(s.name);
        // 登记过的值：打码以后多出来的占位符就是，名字从占位符里读出来（agent 只看得到占位符，原样写进文件的不算）
        const redacted = deps.redactor.redact(f.added);
        if (redacted !== f.added) {
          const before = placeholders(f.added);
          for (const [name, n] of placeholders(redacted)) {
            if (n > (before.get(name) ?? 0)) out.add(`${f.path} 里的「${name}」`);
          }
        }
      }
      return [...out];
    },
  };
}

function ownerOf(runId: Id): string {
  return `run:${runId}`;
}

/** 一段文字里每种占位符出现几次 */
function placeholders(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(PLACEHOLDER)) out.set(m[1] as string, (out.get(m[1] as string) ?? 0) + 1);
  return out;
}
