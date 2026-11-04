# 执行环境

每条分支有独立的 rootless 容器，容器里的 root 对应运行 Melina 的用户。网络使用隔离的用户网络，靶场须从该网络可达。
内存和进程数以 Melina 的沙箱配置为准。不能依赖 GPU、宿主机目录或 Docker socket。

| 路径 | 用途 |
| --- | --- |
| `/workspace` | 当前工作区；持久产物保存在这里。Scoper 只读，Explorer 可写 |
| `/melina/materials` | 题目附件，按原文件名只读挂载 |
| `/melina/origin` | 选择的工作目录的原始副本，只读 |
| `/melina/artifacts` | 当前分支可见的工具原始输出，只读 |
| `/melina/ctf` | 本环境参考 |
| `/opt/venv` | 默认的分析 Python；登录 shell 也使用该解释器 |
| `/opt/ctf/share/playwright` | Python Playwright 配套 Chromium 和 headless shell；构建时已下载 |
| `/opt/ctf/share/wordlists` | Web 小字典、常用字典、dirsearch 字典和 rockyou |
| `/opt/ctf/share/nuclei-templates` | 本地 Nuclei 模板库，包含项目补充模板 |
| `/opt/ctf/share/vulhub` | 本地 Vulhub 资料；不在分支里启动 Docker |
| `/opt/ctf/share/python-offline` | 离线 Python wheel 和带 SHA-256 的锁文件 |

`ctf-wordlists` 列出字典；`ctf-wordlists web-small`、`web-common`、`dirsearch`、`rockyou` 输出相应路径。
`web-small` 保留原有 DIRB 小词表，在开头补充原表缺少的 Web 词条；按当前目标选取候选，不自动展开所有双段组合。
dirsearch 字典含 `%EXT%`，按该工具的语法使用。

容器文件系统可写，可以在分支里安装临时依赖。只有工作区参与 snapshot 和交付：`HOME`、临时目录、安装的新包和后台进程不会随 fork 带入新分支。
暂停后恢复会保留同一个容器里的安装，后台服务需要重新启动。接力分支使用新容器，临时安装不会自动带入，须按交接摘要恢复依赖和服务。
可执行附件、编译产物和本地原生库放在工作区或 `HOME`；`/tmp` 是否可执行由实际挂载决定，`ctf-check` 会报告。
镜像保证 `/tmp`、`/var/tmp` 存在且权限为 `1777`，供 pyvex/angr 缓存和其他临时文件使用。
