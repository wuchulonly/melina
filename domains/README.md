# 领域镜像

领域只决定分支容器用哪个镜像（spec §11「领域与镜像」）。每个领域一个目录：

- `Dockerfile`：从 `ARG BASE`、`FROM ${BASE}` 开始，继承基础镜像的 `ENTRYPOINT` 和 `CMD`。
- `description.txt`：一句描述，给 Scoper 选领域用。

`_base/` 是基础镜像（Ubuntu 24.04 加常用命令行工具、tini、`/opt/venv`），下划线开头的目录不是领域。

| 领域 | 适合的任务 | 内容 |
| --- | --- | --- |
| general | 拿不准归哪类的任务，Scoper 也用它 | 基础镜像 |
| code | 写代码、修 bug、对接接口 | 编译、构建与开发工具 |
| research | 调研、写报告、数学证明 | 文档、数学与证明工具 |
| ctf | 授权 CTF 与安全实验 | 原生 Kali、分析 Python、浏览器、协议、口令恢复与逆向工具 |

三个通用领域共用基础层。CTF 使用 Kali，只从基础层取 tini；恢复、增量更新和比赛调度见 [CTF 说明](../ctf/README.md)。实际大小由构建命令报告。

## 构建

```sh
pnpm images              # 建缺的（先基础镜像，再各领域）
pnpm images code         # 只建 code
pnpm images --force      # 全部重建
pnpm images --prune      # 建完删掉旧标签的 Melina 镜像
```

标签按目录内容和 Git 的属主执行位计算（`localhost/melina-<领域>:<哈希>`）：改了 Dockerfile 标签就变，ACL 的 group 执行位不会改变标签。Melina 启动时发现镜像不在会提示先跑 `pnpm images`。容器引擎默认找 PATH 里的 podman，再找 docker；也可以用环境变量 `MELINA_CONTAINER_ENGINE` 指定。构建与服务须使用同一个用户的引擎和镜像存储。

部署可通过 `MELINA_DOMAINS_DIR=/绝对路径/domains` 指定独立维护的领域配方。构建镜像和启动 Melina 时使用同一个目录，其中包含 `_base/` 和配置 `domains` 里的各领域。未指定时使用本仓库的 `domains/`。

## 加领域

加一个目录（Dockerfile 和 description.txt），再把名字加进配置 `domains`（附录 B，只能全局改，`PUT /settings` 的 config），跑 `pnpm images`。
