# CTF 领域镜像

CTF 使用完整 Kali 工具链，默认 Python 仍遵循 Melina 的 `/opt/venv` 约定。
系统资源在 `/opt/ctf`，参考在 `/melina/ctf`，入口为 `ctf-check`、`ctf-wordlists`、`ctf-python`。

`nuclei-custom/` 保存项目维护的补充模板；常规构建和增量刷新在上游库更新后，将它们同步到 `/opt/ctf/share/nuclei-templates/http/custom/`，统一从本地模板库检索。适用条件、参数与副作用写在模板自身的 `info` 中。

`capabilities.json` 是支持的命令与默认 Python 导入清单。`ctf-check --quick` 使用实际 PATH 和解释器逐项核对，汇报全部缺口并执行 `pip check`；镜像构建和托管启动、导出复用同一清单。
`ctf-check --smoke` 继续验证真实功能，包括 Telnet 协商、expect/pexpect 终端交互、同步与异步 HTTP、两种 WebSocket 客户端、GNU time 和 traceroute 回环调用。检查不访问题目目标。
固定依赖包含 `standard-telnetlib`（Python 3.13+）、`pexpect`、`aiohttp`、`httpx`、`websocket-client` 和 `websockets`；这些支持能力的变化必须同时更新清单、依赖和功能检查。

```sh
pnpm images ctf
```

构建固定 Kali 基础镜像的摘要、分析 Python 的依赖版本、离线 Python 的全部 wheel 哈希及 JDWP 源码修订。
Kali 的系统包仍来自 rolling 仓库；普通重新构建会获取当时可用的系统包和模板。恢复此次验收的确切环境使用部署备份中的原生 rootfs 归档及 SHA-256，不能把滚动构建当作字节相同的恢复。

与 Ubuntu 领域不同，CTF 只从 Melina 基础阶段取 `tini`，最终系统为 Kali，不混装两个发行版的库。
容器以 rootless 的 root 运行，沿用 Melina 的网络、工作区挂载、进程管理和资源上限。工具自检覆盖登录 shell 的解释器、离线创建环境、协议交互、口令恢复和逆向分析。

`provenance.json` 记录迁移来源与固定版本，`analysis-requirements.txt` 是默认分析解释器的完整依赖版本，包含新增的浏览器、图片、OCR、Web、数学和协议 Python 包。
`install-supplement.sh` 安装解题中实际缺失的系统工具、Playwright 配套浏览器和固定提交的 `jwt_tool`。按部署要求，镜像不包含 SageMath，以控制体积；保留 `gmpy2` 等分析 Python 包和 `Rscript`。
镜像提供权限为 `1777` 的 `/tmp`、`/var/tmp`，供 angr/pyvex 缓存使用。`ctf-check --smoke` 还会实际运行 OCR、图片处理、音频隐写、Flask cookie 字典恢复、浏览器 JavaScript 和 GMP 运算等离线样例。
旧环境的工具入口、路径和运行时配置不进入新容器；工具调用自动记录为 Observation，复现脚本、验证结果和交付材料保存在工作区，接力时通过快照和交接摘要延续。
