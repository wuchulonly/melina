# 工具说明

使用工具须遵守当前任务的 CTF 执行约束，包括扫描范围和口令验证的后置条件。

| 工具 | 本地入口与差异 |
| --- | --- |
| Ghidra | `analyzeHeadless`；项目目录须可写，Java 的 HOME 和原生库缓存跟随当前容器 |
| angr | 默认 `python3` 可导入 angr 10；求解器入口是 `from angr import claripy` |
| hashcat、John | 有 CPU OpenCL 后端；没有 GPU，限制线程可设置 `POCL_MAX_PTHREAD_COUNT`、`OMP_NUM_THREADS` |
| gdb、strace | 调试容器内的程序；gdb 可用 `set disable-randomization off` 避开 ASLR 设置限制 |
| dirsearch | 固定使用系统 Python，避免分析 venv 影响 Kali 的系统依赖 |
| Nmap | 默认设置 `NMAP_UNPRIVILEGED=1`，TCP 扫描使用普通连接；显式命令可用 `nmap --unprivileged -sT -Pn -n -sV -p <题目端口> <目标>`。容器内 root 不保证原始套接字权限，`-sS`、`-sU`、`-O` 需要额外权限 |
| Nuclei | 使用本地模板库，关闭自动更新检查 |
| Telnet / 交互终端 | `telnet`、`expect`；默认 Python 预装 `telnetlib` 兼容包和 `pexpect`，可直接导入 |
| HTTP / WebSocket | 默认 Python 可导入 `requests`、`aiohttp`、`httpx`、`websocket`、`websockets` |
| httpx 命令 | ProjectDiscovery HTTP 探测器；与 Python `import httpx` 的客户端库分开，使用 `httpx -version` 核对 |
| 计时 / 网络路径 | GNU `/usr/bin/time` 支持 `-f`；`traceroute` 可用 |
| FRP | `frpc` 和 `frps`，版本 0.71.1 |
| 浏览器 | Chromium、`playwright-cli`、Python `playwright`；Python API 默认使用 `/opt/ctf/share/playwright` 内匹配版本的浏览器 |
| R | `Rscript`；独立系统解释器 |
| Flask cookie | `flask-unsign` 与 `flask-unsign-wordlist`；省略 `--wordlist` 时使用内置字典 |
| 图片与音视频 | `tesseract`（英文、简体中文）、`ffmpeg`、ImageMagick `convert` / `magick`、`exiftool`、`steghide`、`binwalk` |
| JWT | `jwt_tool`；固定上游 Python 3 源码，默认使用分析 venv |

另有 nmap、naabu、sqlmap、proxychains、socat、chisel、radare2、NetExec、BloodyAD、enum4linux-ng、Coercer、pwncat、ADB、gitleaks、krb5 和云服务 CLI。
在执行约束允许时使用本机 `--help` 查询语法；安装排查先用 `ctf-check --quick`：一次汇报命令、默认 Python 导入和包依赖的全部缺口。
能力清单在 `/opt/ctf/capabilities.json`；`ctf-check --smoke` 另做离线功能验证。
先核对当前解释器和现成客户端，再决定是否安装依赖或实现协议。某个 Python 库缺失不代表对应 CLI 也不可用。
Python 包版本用 `importlib.metadata.version("pwntools")` 等分发包名查询；`pwn.__version__` 不是有效接口。
`sh` 默认开启 `pipefail`，`工具 2>&1 | tail -n 40` 会保留前面的失败状态；不额外开启 `errexit`。预期的无匹配或提前截断须显式处理；出现 `Operation not permitted`、`QUITTING!` 等执行错误时，修正调用后重新验证，不能记为目标没有漏洞。

补充命令：`mysql`（MariaDB 兼容客户端）、`redis-cli`、`go`、`sshpass`、`7z`（现代 7zip）、`ruby`、`wpscan`、`psql`、`jadx`、`ltrace`、`sqlite3`、`dig`、`hydra`、`whatweb`、`wafw00f`、`hashid`、`enum4linux`、`patator`、`cewl`、`crunch`、`medusa`、`subfinder`、`katana`、`commix`、`dalfox`、`arjun`。
默认 `python3` 可导入 `PIL`、`cv2`、`pytesseract`、`bs4`、`lxml`、`gmpy2`、`scapy`、`impacket`、`redis`、`pydash`（8.1.0）；系统的 `impacket-secretsdump` 等入口仍使用 Kali 自己的解释器。
`jwt_tool` 包含 Python 3.14 的配置写入兼容补丁；首次运行生成 HOME 内的配置后按上游行为退出，随后可正常解析和测试 JWT。

Python 浏览器示例：

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
    page = browser.new_page()
    page.goto("http://目标/")
    print(page.content())
    browser.close()
```

浏览器 CLI 使用镜像内的 Chromium 配置：`playwright-cli open http://目标/ --config=/opt/ctf/playwright.json`。
命令结束后用 `playwright-cli close` 关闭该会话；创建多个会话时用 `-s=会话名` 区分。

`jdwp-shellifier` 是固定提交并附带本地修补的 Python 3 版。套接字超时 15 秒；`--break-on` 需要目标已加载并会再次调用的非 native 方法。
命令经 `Runtime.exec(String)` 执行，不解释 shell 管道或重定向。`--no-wait` 跳过输出读取，调试连接需在分支之间协调释放。
