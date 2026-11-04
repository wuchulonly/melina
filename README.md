# Melina

**腾讯黑客松第 14 名。**

Melina 是一个自主任务求解 Agent，支持并行探索、隔离执行和过程记录。

## 环境要求

需要 Node.js 24.11 或更高版本，以及 pnpm 11：

```sh
pnpm install --frozen-lockfile
pnpm check   # 类型检查、代码规范、依赖边界与单元测试
```

## 快速启动

```sh
pnpm --dir web build         # 构建前端资源（输出至 web/dist）
pnpm melina serve            # 启动服务：http://127.0.0.1:7474 ，默认数据目录 ~/.melina
pnpm melina serve --help     # 查看端口、数据目录、前端静态目录配置
```

Melina 默认仅监听 `127.0.0.1`，并对请求校验 `Host` 与 `Origin`。数据目录包含：

- `melina.db`：SQLite 状态与事件数据库
- `melina.key`：用于加密 API Key 与容器凭证的本地密钥（权限 `0600`）
- `artifacts/`：命令输出与交付物存储
- `workspaces/`：各分支隔离的工作区快照

## 环境变量

- `MELINA_PORT`：HTTP 监听端口（默认 `7474`）
- `MELINA_HOME`：数据目录路径（默认 `~/.melina`）
- `MELINA_WEB`：前端静态资源目录（默认 `web/dist`）
- `MELINA_SECRET_KEY`：32 字节 Base64 或 Hex 密钥（替代 `melina.key` 文件）
- `MELINA_CONTAINER_ENGINE`：容器引擎（`podman` 或 `docker`）
- `MELINA_DOMAINS_DIR`：自定义领域镜像配方目录

## 领域镜像构建

分支在 rootless Podman（或 Docker）容器中执行，使用前可按需构建领域镜像：

```sh
pnpm images code research general  # 构建通用领域镜像
pnpm images general          # 仅构建指定领域镜像
```

比赛平台的外部调度脚本、宿主机部署配置、运行记录与凭据不包含在此源码发布中。

源码与测试的命名、注释及升级约定见 [维护约定](docs/maintenance.md)。

## 致谢

特别感谢 [QiantangCredit/heimdall-agent](https://github.com/QiantangCredit/heimdall-agent) 的开源分享，为本项目的开发与探索提供了参考。感谢维护者与贡献者对 Agent 实践的分享。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方工具、字体与资源保留各自的许可证。
