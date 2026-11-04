# 三组执行机制比较

比较生产 Melina direct 会话与 Watcher、Heimdall 式持续 Pi 与判断图适配、单 Pi 基线。Melina 使用 `src/api/runtime.ts` 的生产装配，关闭摘要接力并显式指定一个 direct 模型，以固定求解分支数。

默认使用 `scenarios` 题库，可通过 `--tasks` 选择子集。各组使用相同任务种子、模型和时间及 token 上限；参考解、真值及外部判题结果不提供给模型。原版 Heimdall schema 与合并函数位于 `vendor/` 并保留 MIT 许可。

执行使用 rootless Podman、相同领域镜像、2 GiB 内存和 256 进程上限。API key 从私有文件读取。结果记录成功率、耗时、token、费用、实际探索的路线和角色用量。

先运行 `node test/eval/three-way/run.ts --verify-only --out <存档> --keys <私有文件>` 校验题目，再去掉 `--verify-only` 执行。源码与任务配置记录在每批结果的元数据中；机制或清单不同的批次分别比较。
