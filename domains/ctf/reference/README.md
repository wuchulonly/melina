# Melina CTF 环境

这是 CTF 领域的 Kali 环境。通过 `sh` 使用系统工具，通过 `read` 读取 `/melina/ctf/` 下的参考。

| 需要的信息 | 参考 |
| --- | --- |
| 工作区、附件、字典与资料路径 | [执行环境](environment.md) |
| 指定版本的 Python、离线源码和可写环境 | [离线 Python](python.md) |
| 预装工具的版本差异 | [工具说明](tools.md) |
| 原始证据与交付物放在哪里 | [证据与产物](evidence.md) |

`ctf-check --quick` 按 `/opt/ctf/capabilities.json` 汇报命令、Python 模块和包依赖缺口；`ctf-check` 检查完整安装；`ctf-check --smoke` 使用容器内的合成样本和回环服务检查工具的实际功能。
这些检查不访问题目目标。环境版本只描述本地工具，不代表目标的技术栈。
