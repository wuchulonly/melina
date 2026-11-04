// 配置存储。实现在 src/config/。
// 模型、设置、凭证几张表（providers、provider_keys、models、settings、credentials）只由它读写；API key 和凭证加密存放，只写不读。

import type { MelinaOptions } from '../api.ts';
import type { GlobalConfig, ModelsConfig, Settings } from '../config.ts';
import type { Id } from '../ids.ts';
import type { ResolvedCredential } from './container.ts';

/** 解密后的一个 API key，只给 melinaStream 用 */
export interface ResolvedProviderKey {
  id: Id;
  name?: string;
  key: string;
}

export interface ConfigStore {
  /** GET /models：key 不回，只回 hasKey */
  getModels(): ModelsConfig;
  /** PUT /models：keys 不带就保留这家原来的，带了就整份替换（规则见 ModelsConfig） */
  putModels(config: ModelsConfig): ModelsConfig;
  /** 一家的 API key，解密后按顺序给：第一个是首选，后面是备用；解不开的跳过 */
  apiKeys(provider: string): ResolvedProviderKey[];
  /** GET /settings：凭证的 value 不回，只回 hasValue */
  getSettings(): Settings;
  /** PUT /settings：凭证的 value 不带就保留原值，传空串就删掉；改了只影响之后启动的容器 */
  putSettings(settings: Settings): Settings;
  /** 解密后的凭证，启动容器时给进去 */
  credentials(): ResolvedCredential[];
  /** 默认值合并 settings 里的 config（只能全局改的配置） */
  global(): GlobalConfig;
  /** 数据库为空时，用 SDK 的构造参数当初值；不为空就什么都不做 */
  seed(initial: Pick<MelinaOptions, 'models' | 'sandbox'>): void;
  /** 模型或设置改了就通知（registry、Redactor 要跟着换） */
  onChange(listener: (what: 'models' | 'settings') => void): () => void;
}
