# Melina 的基础镜像（spec §11「领域与镜像」）：常用命令行工具。所有领域镜像都从它构建，共用这一层。
# 容器里的 root 对应宿主机上运行 Melina 的用户（rootless），agent 缺什么就在自己的容器里 apt-get install。
# 改了这个文件，所有领域镜像的标签都会变，跑 pnpm images 重建。
FROM docker.io/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC \
    PAGER=cat \
    GIT_PAGER=cat \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 常用命令行工具；tini 当 1 号进程，回收后台进程留下的僵尸
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq ripgrep fd-find less tree file \
      procps psmisc lsof strace time bc \
      unzip zip xz-utils bzip2 zstd patch rsync xxd make \
      openssh-client iproute2 iputils-ping bind9-dnsutils netcat-openbsd \
      vim-tiny nano sqlite3 gnupg tzdata tini \
      python3 python3-pip python3-venv \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Python 默认用 /opt/venv（看得到系统装的包）：pip install 直接装进去，不碰系统的 Python（PEP 668）
RUN python3 -m venv --system-site-packages /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# agent 自己 git commit 时用的身份；workspace 的属主是宿主机用户，也当安全目录
RUN git config --system user.name Melina \
 && git config --system user.email melina@localhost \
 && git config --system init.defaultBranch main \
 && git config --system advice.detachedHead false \
 && git config --system --add safe.directory '*'

RUN mkdir -p /workspace /melina/artifacts /melina/materials /melina/logs
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
