# code 领域（spec §11）：写代码、修 bug、对接接口。C/C++、Python、Node.js、Go、Rust、Java 的运行环境和构建工具。
# 从基础镜像构建：pnpm images 传 BASE=localhost/melina-base:<标签>。
ARG BASE
FROM ${BASE}

# Ubuntu 的容器镜像不装 man 手册，openjdk 的安装脚本要往 man1 里建链接，先把目录建上
RUN mkdir -p /usr/share/man/man1 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config gdb \
      python3-dev pipx \
      libssl-dev libffi-dev zlib1g-dev libsqlite3-dev libreadline-dev libbz2-dev liblzma-dev libncurses-dev uuid-dev \
      openjdk-21-jdk-headless maven \
 && rm -rf /var/lib/apt/lists/*

# Node.js：24.x 的最新版（官方二进制，按 SHASUMS256 校验），加上 pnpm 和 yarn
RUN set -eux; \
    cd /tmp; \
    case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "不支持的架构"; exit 1 ;; esac; \
    base=https://nodejs.org/dist/latest-v24.x; \
    curl -fsSLO "$base/SHASUMS256.txt"; \
    file="$(grep -o "node-v[0-9.]*-linux-$arch\.tar\.xz" SHASUMS256.txt | head -n 1)"; \
    curl -fsSLO "$base/$file"; \
    grep " $file\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "$file" SHASUMS256.txt; \
    npm install -g pnpm yarn; \
    npm cache clean --force; \
    node --version; pnpm --version; yarn --version

# Go：最新的稳定版（官方二进制，按 go.dev 给的 sha256 校验）
ENV GOPATH=/root/go \
    PATH=/usr/local/go/bin:/root/go/bin:$PATH
RUN set -eux; \
    cd /tmp; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL 'https://go.dev/dl/?mode=json' -o go.json; \
    version="$(jq -r '[.[] | select(.stable)][0].version' go.json)"; \
    file="$version.linux-$arch.tar.gz"; \
    sha="$(jq -r --arg f "$file" '[.[].files[] | select(.filename == $f)][0].sha256' go.json)"; \
    curl -fsSLo "$file" "https://go.dev/dl/$file"; \
    echo "$sha  $file" | sha256sum -c -; \
    tar -xzf "$file" -C /usr/local; \
    rm -f "$file" go.json; \
    go version

# Rust：rustup 装 stable（minimal，加 rustfmt、clippy）
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh; \
    sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain stable --component rustfmt,clippy; \
    rm -f /tmp/rustup-init.sh; \
    rustc --version; cargo --version

# Python 的项目工具：uv，装进 /opt/venv
RUN pip install --no-cache-dir uv && uv --version
