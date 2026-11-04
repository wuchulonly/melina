/**
 * 模块依赖规则，pnpm deps 检查，pnpm check 里也跑。
 * 改这里等于改模块边界，要先问人。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '模块之间不许循环依赖（只看运行时的 import，纯类型的不算）',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'import 的东西必须找得到',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'src-not-to-test',
      comment: 'src/ 不能 import test/ 里的东西',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'core-is-leaf',
      comment: 'src/core 是契约：只依赖自己、typebox 和 node 内置模块，不依赖别的模块',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(?!core/)' },
    },
    {
      name: 'core-only-typebox',
      comment: 'src/core 只能用 typebox 这一个第三方包',
      severity: 'error',
      from: { path: '^src/core/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg'],
        pathNot: 'node_modules/typebox/',
      },
    },
    {
      name: 'pi-only-in-models-and-episode',
      comment: 'pi 的包（@earendil-works/*）只能在 src/models/ 和 src/agents/episode.ts 里 import',
      severity: 'error',
      from: { pathNot: ['^src/models/', '^src/agents/episode\\.ts$', '^test/'] },
      to: { path: 'node_modules/@earendil-works/' },
    },
    {
      name: 'projections-only-core',
      comment: '共享只读投影只依赖 core 契约与本层，不依赖存储、执行或展示实现',
      severity: 'error',
      from: { path: '^src/projections/' },
      to: { path: '^src/(?!core/|projections/)' },
    },
    {
      name: 'projections-no-effects',
      comment: '只读投影不直接访问文件系统、进程或 SQLite',
      severity: 'error',
      from: { path: '^src/projections/' },
      to: { path: ['node_modules/better-sqlite3/', '^(node:)?(fs|fs/promises|child_process|sqlite)$'] },
    },
    {
      name: 'sqlite-only-in-storage-and-config',
      comment: '只有 storage/ 和 config/ 直接访问 SQLite',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/storage/', '^src/config/'] },
      to: { path: ['node_modules/better-sqlite3/', '^(node:)?sqlite$'] },
    },
    {
      name: 'storage-store-private',
      comment:
        'storage/store.ts 是数据库连接，只给 storage/ 自己用；别的模块通过 RunStoreWriter 和 RunStoreQueries 访问',
      severity: 'error',
      from: { pathNot: ['^src/storage/', '^test/'] },
      to: { path: '^src/storage/store\\.ts$' },
    },
    {
      name: 'agents-no-direct-effects',
      comment:
        'agents/ 只负责一次角色调用，只通过 storage/writer、tools/gateway、models/stream 产生副作用，不直接碰 SQLite、文件系统、子进程和 workspace',
      severity: 'error',
      from: { path: '^src/agents/' },
      to: {
        path: [
          '^src/(workspace|runtime|api|config|context)/',
          '^src/storage/store\\.ts$',
          '^src/tools/(?!gateway\\.ts$)',
          'node_modules/better-sqlite3/',
          '^(node:)?(fs|fs/promises|child_process|sqlite)$',
        ],
      },
    },
    {
      name: 'context-read-only',
      comment: 'context/ 只读不写：不碰 RunStoreWriter、workspace、工具和模型调用',
      severity: 'error',
      from: { path: '^src/context/' },
      to: {
        path: [
          '^src/storage/(writer|store)\\.ts$',
          '^src/(runtime|agents|tools|workspace|api|models|config)/',
          'node_modules/better-sqlite3/',
          '^(node:)?(child_process|sqlite)$',
        ],
      },
    },
    {
      name: 'web-only-http',
      comment: 'web/ 只通过 HTTP API 和 SSE 访问 Melina，最多 import src/core 里的类型',
      severity: 'error',
      from: { path: '^web/' },
      to: { path: '^src/(?!core/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // 打过包（pnpm --dir web build、e2e）以后 web/dist 里是打包产物，chunk 之间互相引用，不是源码（发现）
    exclude: { path: '^web/dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.mts', '.js', '.mjs', '.cjs', '.json', '.d.ts', '.d.mts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
