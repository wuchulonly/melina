// 开发机上起 Melina：和 melina serve 一样（同一个 startServer），只是容器换成 proot（test/dev/proot-runtime.ts），
// 模型的 key 从一个本机文件读。这台开发机起不了 Podman，门槛 1 的真模型联调、在前端看真实的 Run 都用它。
//
//   node test/dev/serve.ts [--port 7474] [--data ~/.melina-dev] [--web web/dist] [--keys ~/.melina-keys.env] [--net-allow 80,443,…]
//                          [--strong 供应商/模型,…] [--fast 供应商/模型,…] [--tool-exec N] [--transcript 文件]
//
// key 文件一行一个 NAME=value（DEEPSEEK_API_KEY、DEEPSEEK_API_KEY_2……），
// 只在数据库里还没配过模型时当初值存进去（加密，以数据库为准）；之后改 key、换模型用前端的模型页。
// 两档的模型也只在第一次配：--strong、--fast 按顺序写（第一个是首选）；不写时 DeepSeek 的 key 在就两档都用 deepseek-flash。
// --tool-exec 把 limits.toolExec 固定成 N（跑分用：auto 在这台机器上会被别的会话的负载压到 1，比的就成了谁受干扰少）。
// --transcript 把各角色每次回复的原文（思考、文字、工具调用）、工具结果、追加给模型的话一行一条追加进这个 JSONL 文件
// ，改提示词、改收尾以后比每步想了多少、收尾被退回几次。
// 文件里是模型看到的全部内容（工具输出里的凭证已经换成占位符），只在开发机上用，别提交。
// 同一家配几个 key：名字后面加后缀，例如 DEEPSEEK_API_KEY_BACKUP，按文件里的顺序排，变量名当 key 的名字。
// 不是沙箱：agent 的命令以当前用户跑在这台机器上，只是看不到 /opt、home 这些；它杀得到本机同一个用户的进程
// （`pkill -f node` 会杀到 Melina 自己和别的会话）。每条命令进了 Landlock 域，读不到别的进程的环境变量；
// --net-allow 给了端口就只许连这些（跑分时给仿真环境的端口和 80、443，Melina 的 API 和本机别的服务就连不到），
// 不给就连得到本机所有端口（proot-runtime.ts 开头的说明）。有条件的话换一个单独的用户跑。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { melinaRuntime } from '../../src/api/runtime.ts';
import { startServer } from '../../src/cli.ts';
import type { ModelsConfig } from '../../src/core/config.ts';
import type { Redactor } from '../../src/core/interfaces/container.ts';
import { ProotRuntime } from './proot-runtime.ts';

/** key 文件里的变量名 → DeepSeek 供应商 id */
const KEY_NAMES: Record<string, string> = { DEEPSEEK_API_KEY: 'deepseek' };

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7474' },
    data: { type: 'string' },
    web: { type: 'string' },
    keys: { type: 'string' },
    'net-allow': { type: 'string' },
    strong: { type: 'string' },
    fast: { type: 'string' },
    'tool-exec': { type: 'string' },
    transcript: { type: 'string' },
  },
});

const expand = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : resolve(p));
const home = expand(values.data ?? '~/.melina-dev');
const web = expand(values.web ?? fileURLToPath(new URL('../../web/dist', import.meta.url)));
const keysFile = expand(values.keys ?? '~/.melina-keys.env');

/** 供应商 → 按顺序的 key（变量名当名字） */
function readKeys(file: string): Record<string, { name: string; key: string }[]> {
  if (!existsSync(file)) return {};
  const out: Record<string, { name: string; key: string }[]> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const name = m[1] as string;
    const base = Object.keys(KEY_NAMES).find((k) => name === k || name.startsWith(`${k}_`));
    const provider = base ? KEY_NAMES[base] : undefined;
    const value = (m[2] as string).replace(/^(['"])(.*)\1$/, '$2');
    if (!provider || !value) continue;
    const list = out[provider] ?? [];
    if (!list.some((k) => k.key === value)) list.push({ name, key: value });
    out[provider] = list;
  }
  return out;
}

const keys = readKeys(keysFile);
/** 'deepseek/deepseek-flash,deepseek/deepseek-v4-pro' → 模型列表 */
const tierOf = (text: string | undefined, tier: 'strong' | 'fast') =>
  text === undefined
    ? keys.deepseek
      ? [{ provider: 'deepseek', model: 'deepseek-flash', tier }]
      : []
    : text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const i = s.indexOf('/');
          if (i <= 0) throw new Error(`模型要写成 供应商/模型：${s}`);
          return { provider: s.slice(0, i), model: s.slice(i + 1), tier };
        });
const models: ModelsConfig = {
  providers: Object.entries(keys).map(([provider, list]) => ({ provider, keys: list })),
  strong: tierOf(values.strong, 'strong'),
  fast: tierOf(values.fast, 'fast'),
};

// proot 的输出要和 Melina 用同一份脱敏（凭证在设置页改了跟着换）：Melina 建运行时时把它的 redactor 交出来
let redactor: Pick<Redactor, 'redact'> | undefined;
const netAllow = values['net-allow']
  ?.split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
const containers = new ProotRuntime({
  root: join(home, 'proot'),
  redactor: { redact: (t) => redactor?.redact(t) ?? t },
  ...(netAllow?.length ? { netAllow } : {}),
});
const transcript = values.transcript ? expand(values.transcript) : undefined;
if (transcript) mkdirSync(dirname(transcript), { recursive: true });
const assemble = melinaRuntime({
  ...(transcript ? { transcript: (entry) => appendFileSync(transcript, `${JSON.stringify(entry)}\n`) } : {}),
});

const { melina, stop } = await startServer(
  { port: Number(values.port), home, ...(existsSync(web) ? { web } : {}) },
  {
    models,
    internals: {
      containers,
      runtime: (deps) => {
        redactor = deps.redactor;
        return assemble(deps);
      },
    },
  },
);

if (values['tool-exec']) {
  const settings = melina.settings();
  melina.setSettings({
    ...settings,
    config: {
      ...(settings.config ?? {}),
      limits: { ...(settings.config?.limits ?? {}), toolExec: Number(values['tool-exec']) },
    },
  });
}

console.log(`Melina（开发机，proot）在运行：http://127.0.0.1:${values.port}`);
console.log(`数据目录：${home}`);
const iso = containers.isolation;
console.log(
  iso.landlock
    ? `agent 的命令进了 Landlock 域（读不到本机别的进程的环境变量）；${iso.netAllow ? `只许连 TCP 端口 ${iso.netAllow.join('、')}` : '端口不限'}`
    : '没有 Landlock：agent 读得到本机同一个用户的进程的环境变量',
);
if (!existsSync(web)) console.log('前端还没打包（pnpm --dir web build），现在只有 HTTP 接口能用');
const configured = melina.models();
console.log(
  `模型：strong ${configured.strong.map((m) => m.model).join('、') || '（空）'}，fast ${configured.fast.map((m) => m.model).join('、') || '（空）'}；` +
    `有 key 的供应商：${
      configured.providers
        .filter((p) => p.keys?.some((k) => k.hasKey))
        .map((p) => `${p.provider}（${p.keys?.filter((k) => k.hasKey).length} 个 key）`)
        .join('、') || '（没有）'
    }${values['tool-exec'] ? `；同时执行的命令固定 ${values['tool-exec']} 条` : ''}`,
);
if (transcript) console.log(`各角色回复的原文记在：${transcript}`);

let signals = 0;
const onSignal = () => {
  signals++;
  if (signals > 1) process.exit(1);
  console.log('正在停下……（再按一次 Ctrl+C 直接退出）');
  stop().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
