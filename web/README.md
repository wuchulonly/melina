# Melina 网页前端

任务页展示独立 direct 路线、执行记录、旁观地图、结果和配置。页面通过 `/api` HTTP 与 SSE 访问后端。

在 `web/` 下运行：

- `pnpm dev`：Vite 加真实演示服务。模型按文件写入和核对的剧本回复，不需要 API key；命令在开发机执行，只用于本地演示。
- `pnpm dev:fake`：使用内存演示后端，回放三路直解和摘要接力两套记录。
- `MELINA_API=http://127.0.0.1:<端口> pnpm dev`：连接现有 Melina。
- `pnpm build`：打包到 `dist/`。
- `pnpm check`：类型检查与单元测试。
- `pnpm e2e`：打包后使用内存后端运行浏览器冒烟测试。
- `pnpm e2e:melina`：使用真实演示服务运行浏览器测试。
- `pnpm demo`：打包并启动真实演示服务。

内存后端的测试控制口为 `/__fake/reset`、`/__fake/step`、`/__fake/speed`、`/__fake/drop`，以及只读的 `/__fake/state` 和 `/__fake/secrets`。剧本在 `test/fixtures/runs/`，使用当前事件及 HTTP 契约。

真实演示服务在 `test/dev/demo.ts`，通过当前生产装配创建运行时。`MELINA_DEMO_PACE` 控制每次模拟回复的等待时间，`MELINA_DEMO_DATA` 指定数据目录。

浏览器代码位于 `src/`；`fake/` 和 `dev/` 是 Node 开发工具；`test/` 为单元测试；`e2e/` 与 `e2e-melina/` 分别验证内存和真实演示后端。
