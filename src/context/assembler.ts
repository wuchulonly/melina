// 同一个 RunStore 版本产出逐字节相同的前缀，否则缓存失效。只产出 Melina 自己的类型（Layout），由 agents/episode.ts 转成 Harness 消息。

// 巡检器上下文在 layouts/watcher.ts；给求解分支看的地图在 layouts/explorer.ts 和 watch.ts。

import type { Id } from '../core/ids.ts';
import type {
  ContextAssembler,
  ExplorerUpdate,
  Layout,
  PickRequest,
  WatchRequest,
} from '../core/interfaces/context.ts';
import type { RunStoreQueries } from '../core/interfaces/store.ts';
import type { Branch, Run } from '../core/types.ts';
import { explorerLayout, explorerUpdate, watchMap } from './layouts/explorer.ts';
import { type DomainInfo, scoperLayout } from './layouts/scoper.ts';
import { selectionLayout } from './layouts/selection.ts';
import { watcherLayout } from './layouts/watcher.ts';
import { loadPrompt, type PromptName } from './prompts.ts';

export interface AssemblerDeps {
  /** 巡检器首屏在裁剪前脱敏，与工具读取共用宿主规则。 */
  redact?: (text: string) => string;
  queries: RunStoreQueries;
  /** 可选的领域和描述（GlobalConfig.domains 加 domains/<name>/description.txt），Scoper 选领域、Explorer 查当前环境入口用。 */
  domains?: () => readonly DomainInfo[];
  /** 各角色的系统提示，默认读 src/prompts/<角色>.md */
  prompt?: (name: PromptName, run?: Run) => string;

  /** 进程入口给可选扩展追加工具；读取与网关相同的定义，不改变其他上下文。 */
  tools?: (layout: Layout, branch?: Branch) => Layout['tools'];
}

export class MelinaContextAssembler implements ContextAssembler {
  readonly #queries: RunStoreQueries;
  readonly #redact: (text: string) => string;
  readonly #domains: () => readonly DomainInfo[];
  readonly #prompt: NonNullable<AssemblerDeps['prompt']>;

  readonly #tools: AssemblerDeps['tools'];

  constructor(deps: AssemblerDeps) {
    this.#queries = deps.queries;
    this.#redact = deps.redact ?? ((text) => text);
    this.#domains = deps.domains ?? (() => []);
    this.#prompt = deps.prompt ?? loadPrompt;

    this.#tools = deps.tools;
  }

  forExplorer(branch: Branch): Layout {
    return this.withTools(
      explorerLayout({ queries: this.#queries, prompt: this.promptFor(branch.runId), domains: this.#domains }, branch),
      branch,
    );
  }

  explorerUpdate(branch: Branch, sinceSeq: number): ExplorerUpdate | undefined {
    return explorerUpdate({ queries: this.#queries, prompt: this.promptFor(branch.runId) }, branch, sinceSeq);
  }

  forScoper(run: Run): Layout {
    return this.withTools(
      scoperLayout({ queries: this.#queries, prompt: this.promptFor(run.id), domains: this.#domains }, run),
    );
  }

  forSelection(runId: Id, request: PickRequest): Layout {
    return this.withTools(selectionLayout({ queries: this.#queries, prompt: this.promptFor(runId) }, runId, request));
  }

  forWatcher(runId: Id, request: WatchRequest): Layout {
    return this.withTools(
      watcherLayout({ queries: this.#queries, prompt: this.promptFor(runId), redact: this.#redact }, runId, request),
    );
  }

  watchMap(branchId: Id): string | undefined {
    return watchMap({ queries: this.#queries, prompt: this.#prompt }, branchId);
  }

  private promptFor(runId: Id): (name: PromptName) => string {
    return (name) => this.#prompt(name, this.#queries.getRun(runId));
  }

  private withTools(layout: Layout, branch?: Branch): Layout {
    return this.#tools ? { ...layout, tools: this.#tools(layout, branch) } : layout;
  }
}
