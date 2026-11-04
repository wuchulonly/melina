# Melina 通过 bash -l 执行命令；Kali 的 /etc/profile 会重置 PATH，在此恢复分析解释器。
export VIRTUAL_ENV=/opt/venv
export PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/opt/ctf/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CTF_REFERENCE=/melina/ctf/README.md
export NO_UPDATE_NOTIFIER=1
export PLAYWRIGHT_BROWSERS_PATH=/opt/ctf/share/playwright
# 容器内 UID 0 不代表拥有 CAP_NET_RAW；让 Nmap 默认使用普通套接字。
export NMAP_UNPRIVILEGED=1
