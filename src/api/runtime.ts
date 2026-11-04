// 默认运行时装配：长会话、旁观地图、事件触发的摘要接力。

import { createRoleCallRunner, type RoleCallDeps } from '../agents/episode.ts';
import { createExplorerAgent } from '../agents/explorer.ts';
import { createScoperAgent } from '../agents/scoper.ts';
import { createSelectVersion } from '../agents/select-version.ts';
import { createWatcherAgent } from '../agents/watcher.ts';
import { MelinaContextAssembler } from '../context/assembler.ts';
import type { DomainInfo } from '../context/layouts/scoper.ts';
import { loadPrompt } from '../context/prompts.ts';
import { conflict, MelinaError } from '../core/errors.ts';
import type { ContainerRuntime } from '../core/interfaces/container.ts';
import { createMelinaStream, type MelinaStreamDeps } from '../models/stream.ts';
import { createTextGenerator } from '../models/text.ts';
import type { Clock } from '../runtime/async.ts';
import { ContinuationCoordinator } from '../runtime/continuations.ts';
import { createKernel, createRuntimeScheduler, type RuntimeKernel } from '../runtime/runtime.ts';
import { listDomains } from '../tools/container-images.ts';
import { extendTools } from '../tools/extensions.ts';
import { MelinaToolGateway } from '../tools/gateway.ts';
import { ArtifactViews } from '../tools/views.ts';
import type { InfraDeps, Runtime, RuntimeFactory } from './assemble.ts';
import { type RuntimeExtension, type RuntimeExtensionFactory, runtimeExtensions } from './extensions.ts';
import { runSecrets } from './run-secrets.ts';
import { freezeProblem, missingKeys } from './status.ts';
import { WatchInputs } from './watch-input.ts';

export interface RuntimeOptions {
  /** 可选工具与私有状态的接入；不给时读取显式设置的本地扩展入口。 */
  extensions?: readonly RuntimeExtensionFactory[];
  /** 思考级别；省略时按角色和模型档位选择（agents/episode.ts 的 defaultThinking）。 */
  thinking?: RoleCallDeps['thinking'];
  /** 记回复原文，只给开发脚本用（test/dev/serve.ts 的 --transcript）：各角色每次回复、工具结果、追加的话 */
  transcript?: RoleCallDeps['transcript'];
  /** melinaStream 的退避（测试里调短） */
  backoff?: MelinaStreamDeps['backoff'];
  /** 系统出错后的重试间隔（测试里调短） */
  retryDelaysMs?: readonly number[];
  /** 巡检器第一轮、之后每轮隔多久 */
  watchPace?: { firstMs: number; everyMs: number };
  clock?: Clock;
  /** 拿到组装好的 runtime（测试、开发脚本要直接看它的内部） */
  onCreated?: (runtime: RuntimeKernel) => void;
  /** 拿到摘要调度器（测试、开发脚本）。 */
  onContinuations?: (coordinator: ContinuationCoordinator) => void;
}

/** Melina 默认的运行时：装配时没给 internals.runtime 就用它 */
export function melinaRuntime(options: RuntimeOptions = {}): RuntimeFactory {
  return (deps) => assemble(deps, options);
}

function assemble(deps: InfraDeps, options: RuntimeOptions): Runtime {
  const { writer, queries, bus, artifacts, config, registry, ledger, redactor, containers, workspaces, paths, log } =
    deps;
  const notice = (text: string) => log.warn(text);
  const watchInputs = new WatchInputs(deps);

  const scheduler = createRuntimeScheduler({
    queries,
    config: { global: () => config.global(), models: () => config.getModels() },
    dataDir: paths.dataDir,
    ...(options.clock ? { clock: options.clock } : {}),
    // 排队、容量变了马上推系统状态
    onChange: () => deps.statusChanged?.(),
  });
  const stream = createMelinaStream({
    registry,
    scheduler,
    ledger,
    onNotice: notice,
    onTiming: (timing) => {
      if (timing.role === 'watcher') notice(`观察者模型请求：${JSON.stringify(timing)}`);
    },
    ...(options.backoff ? { backoff: options.backoff } : {}),
  });
  const runner = createRoleCallRunner({
    stream,
    registry,
    publicText: (caller, text) => watchInputs.publicText(caller, text),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.transcript ? { transcript: options.transcript } : {}),
    onNotice: notice,
  });
  const domains = () => config.global().domains;
  const explorer = createExplorerAgent({ runner, onNotice: notice });
  const scoper = createScoperAgent({ runner, registry, domains, onNotice: notice });
  const views = new ArtifactViews({ dataDir: paths.dataDir, artifacts });

  const extensions = runtimeExtensions(deps, options.extensions);
  const tools = extensions.flatMap((extension) => [...extension.tools]);
  const gateway = new MelinaToolGateway({
    writer,
    queries,
    // 求解分支先于 Scoper 完成起草开跑；提交候选时若标准尚未定好，提交工具等待起草完成。
    bus,
    artifacts,
    runtime: containers ?? missingContainers,
    toolSlots: scheduler,
    redactor,
    views,
    ledger,
    domains,
    extensions: tools,
    toolChecks: extensions.flatMap((extension) => (extension.checkTool ? [extension.checkTool] : [])),
    beforeTools: extensions.flatMap((extension) => (extension.beforeTool ? [extension.beforeTool] : [])),
    submissionGuards: extensions.flatMap((extension) => (extension.beforeClose ? [extension.beforeClose] : [])),
    // 存个阶段版：打 snapshot、写成一版
    deliver: { deliver: (req) => kernel.runners.deliver(req) },
    onError: (error, what) => log.error(`工具：${what}`, error),
    onNotice: notice,
  });

  const assembler = new MelinaContextAssembler({
    redact: (text) => redactor.redact(text),
    queries,
    domains: () => domainInfos(domains()),
    prompt: (name, run) =>
      [
        loadPrompt(name),
        ...extensions.flatMap((extension) => {
          const prompt = extension.prompts?.[name];
          const text = typeof prompt === 'function' ? (run ? prompt({ run }) : undefined) : prompt;
          return text ? [text] : [];
        }),
      ].join('\n\n'),
    tools: (layout) => extendTools(layout.tools, tools, layout.role),
  });
  for (const extension of extensions) extension.prepare?.({ gateway, assembler });
  const generate = createTextGenerator({ stream, registry });
  // 挑版：交过两版以上时比较各版、挑一版，任务停下时交付它
  const selectVersion = createSelectVersion({ generate, assembler });
  // 巡检器：主干直解路线每做一段看一轮；模型用它看的那份自己的，那家用不了时换和它不同家的
  const watcher = createWatcherAgent({
    runner,
    gateway,
    assembler,
    registry,
    onNotice: notice,
  });

  const kernel = createKernel({
    writer,
    queries,
    bus,
    artifacts,
    workspaces,
    containers,
    gateway,
    assembler,
    explorer,
    scoper,
    selectVersion,
    watcher,
    watchInputs: {
      collect: (run, branchId, signal) => watchInputs.collect(run, branchId, extensions, signal),
      read: (run, request, signal) => watchInputs.read(run, request, signal),
    },
    registry,
    config: { global: () => config.global(), credentials: () => config.credentials() },
    scheduler,
    dataDir: paths.dataDir,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
    ...(options.watchPace ? { watchPace: options.watchPace } : {}),
    ...(containers?.forceRemove ? { forceRemove: containers.forceRemove } : {}),
    ...(containers ? { freeze: containers.withWorkspaceFrozen.bind(containers) } : {}),
    secrets: extensionSecrets(runSecrets({ dataDir: paths.dataDir, artifacts, redactor }), extensions, watchInputs),
    createContinuations: ({ branches, runners, scopes }) => {
      const continuations = new ContinuationCoordinator({
        writer,
        queries,
        bus,
        branches,
        runners,
        scopes,
        generate,
        dataDir: paths.dataDir,
        redact: (text) => redactor.redact(text),
        ...(options.clock ? { clock: options.clock } : {}),
        log: notice,
      });
      options.onContinuations?.(continuations);
      return continuations;
    },
    // 容器、冻结能力或模型 key 不满足时，创建任务前直接报错。
    beforeCreate: async () => {
      if (!containers) {
        throw new MelinaError(
          'unavailable',
          '没找到容器引擎（podman 或 docker）：分支跑不起来。装好 rootless Podman 后重启 Melina',
        );
      }
      const sandbox = await containers.probe();
      if (process.platform === 'linux' && !sandbox.rootless) {
        throw new MelinaError(
          'unavailable',
          `${sandbox.kind} 不是 rootless 模式：先配置 rootless 容器引擎，才能运行任务`,
        );
      }
      const freeze = await containers.checkFreeze?.(config.global().domains);
      if (freeze && !freeze.ok) throw new MelinaError('unavailable', freezeProblem(sandbox.kind, freeze.error));
      const missing = missingKeys(registry);
      if (missing.length > 0) throw new MelinaError('unavailable', `模型页里${missing.join('；')}，先去模型页填上`);
    },
    onRecover: async (runId) => {
      for (const extension of extensions) await extension.recover?.(runId);
    },
    log: notice,
  });
  options.onCreated?.(kernel);
  return kernel;
}

// 建任务前查的「每一档都要用得上」和系统状态的提示同一个口径，写在 status.ts；测试和别处照旧从这里拿
export { missingKeys };

/** Scoper 选领域用：配置里的领域按配置的顺序，描述取 domains/<名字>/description.txt */
export function domainInfos(names: readonly string[]): DomainInfo[] {
  const known = new Map(listDomains().map((d) => [d.name, d.description]));
  return names.map((name) => ({ name, description: known.get(name) ?? '' }));
}

function extensionSecrets(
  secrets: ReturnType<typeof runSecrets>,
  extensions: readonly RuntimeExtension[],
  watchInputs: WatchInputs,
): ReturnType<typeof runSecrets> {
  return {
    ...secrets,
    drop: (runId) => {
      watchInputs.drop(runId);
      try {
        for (const extension of extensions) extension.drop?.(runId);
      } finally {
        secrets.drop(runId);
      }
    },
  };
}

/** 没有容器引擎时给 ToolGateway 的：建任务那里已经拦了，走到这里说明是恢复出来的老 Run */
const missingContainers: Pick<ContainerRuntime, 'exec'> = {
  exec: async () => {
    throw conflict('没有容器引擎，命令跑不了');
  },
};
