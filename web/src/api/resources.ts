// 外壳用到的 GET，每个一个 key。工作台页按同样的写法加自己的，key 以 run:<id> 开头，
// 这个 Run 的事件来了会一起 invalidate（live.tsx）。

import type {
  ModelCatalogResponse,
  RunListResponse,
  RunSummary,
  StatusResponse,
  UsageResponse,
} from '../../../src/core/api.ts';
import type { ModelsConfig, Settings } from '../../../src/core/config.ts';
import type { Id } from '../../../src/core/ids.ts';
import { api } from './client.ts';
import type { ResourceDef } from './resource.ts';

export const RUNS: ResourceDef<RunListResponse> = { key: 'runs', fetch: (s) => api.listRuns(s) };
export const STATUS: ResourceDef<StatusResponse> = { key: 'status', fetch: (s) => api.status(s) };
export const USAGE: ResourceDef<UsageResponse> = { key: 'usage', fetch: (s) => api.usage(s) };
export const MODELS: ResourceDef<ModelsConfig> = { key: 'models', fetch: (s) => api.getModels(s) };
/** DeepSeek 模型目录（版本锁定，Melina 运行期间不变）：模型页的下拉用 */
export const MODEL_CATALOG: ResourceDef<ModelCatalogResponse> = {
  key: 'model-catalog',
  fetch: (s) => api.modelCatalog(s),
};
export const SETTINGS: ResourceDef<Settings> = { key: 'settings', fetch: (s) => api.getSettings(s) };

export function runResource(id: Id): ResourceDef<RunSummary> {
  return { key: `run:${id}`, fetch: (s) => api.getRun(id, s), same: (a, b) => a.lastSeq === b.lastSeq };
}
