// 开工清单（lib/setup.ts）：任务页列出尚未完成的配置步骤，配好了就不出现。

import { useResource } from '../api/resource.ts';
import { MODELS, RUNS, STATUS } from '../api/resources.ts';
import { type SetupStep, setupSteps } from './setup.ts';

/** 还差的步骤；配好了（或者还没拉回来）是 null */
export function useSetupSteps(): SetupStep[] | null {
  const models = useResource(MODELS);
  const status = useResource(STATUS);
  const runs = useResource(RUNS);
  return setupSteps(models.data, status.data, runs.data?.runs.length);
}
