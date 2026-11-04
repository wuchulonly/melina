# 离线 Python

默认 `python3` 是 `/opt/venv` 中的分析环境，含 pwntools、angr、数据库驱动、Flask、JWT 和云服务 CLI 依赖。
网络脚本可直接导入 `telnetlib`、`pexpect`、`requests`、`aiohttp`、`httpx`、`websocket` 和 `websockets`。
Python 3.13+ 的 `telnetlib` 由固定版本的 `standard-telnetlib` 提供，保留旧脚本的导入和 `Telnet` API。
其他已移除的标准库不视为默认环境能力；运行旧代码前核对兼容性，必要时使用下述 Python 3.11 环境。
指定旧版本分析时，使用独立的 Python 3.11.16 环境：pydash 8.1.0 或 Gradio 4.12.0。

```sh
ctf-python list
ctf-python run pydash -c 'import pydash; print(pydash.__version__)'
ctf-python run gradio analysis.py
ctf-python source gradio
ctf-python create gradio /workspace/envs/gradio
```

`source` 输出可读的包源码目录。`create` 只接受 `/workspace` 或 `HOME` 下尚不存在的绝对路径，拒绝覆盖；失败时清理此次新建的环境。
创建完全使用本地 wheel，关闭包索引并校验锁文件中的 SHA-256。创建后调用目标的 `bin/python`。
这个入口关闭 Gradio 遥测，默认设置 `GRADIO_ALLOW_FLAGGING=never`，避免在只读工作区创建 `./flagged`；缓存使用 `XDG_CACHE_HOME`，默认在当前容器的 `HOME/.cache`。
直接运行新环境时设置 `GRADIO_ANALYTICS_ENABLED=False GRADIO_ALLOW_FLAGGING=never`。Gradio 4.12.0 使用的是 `GRADIO_ALLOW_FLAGGING`，不识别 `GRADIO_FLAGGING_MODE`。
需要收集 flagging 样本时，可显式设置 `GRADIO_ALLOW_FLAGGING=manual`（或传入 `allow_flagging='manual'`），并将 `flagging_dir` 指向 `HOME` 下的可写目录。

离线 bundle 只覆盖上述版本；分析别的版本需要显式添加依赖。改动依赖时使用新环境，保留默认解释器给现有工具使用。
