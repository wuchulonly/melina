#!/usr/bin/env bash
set -euo pipefail

# CTF 镜像的原生 Kali 工具；版本锁在 analysis-requirements.txt。
test "$(dpkg --print-architecture)" = amd64
readonly frp_version=0.71.1
readonly frp_sha256=1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803
readonly angr_version=10.0.4.post1
readonly jdwp_revision=30471c2ac7da5fb5f3fd197cd26cd8089f4d74e8
readonly jdwp_sha256=4fe3eafe7e6ea09ffcf2f8b370f3f56a13f818b05a45ec16ff24c5464e08068e
toolchain_tmp=$(mktemp -d)
trap 'rm -rf "$toolchain_tmp"' EXIT

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl proxychains4 socat chisel sqlmap hashcat john wordlists \
    ocl-icd-libopencl1 pocl-opencl-icd \
    gdb radare2 ghidra gcc libc6-dev dirsearch python3-pkg-resources python3-setuptools \
    bc python3-dev default-libmysqlclient-dev pkg-config \
    file xxd php-cli iproute2 strace inetutils-telnet expect ffuf dirb patch

# 默认 Python 与 Melina 的其他领域一样使用 /opt/venv。
/opt/venv/bin/python3 -m pip install --no-cache-dir \
    --constraint /opt/ctf/analysis-requirements.txt "angr==${angr_version}" PyMySQL mysqlclient Flask 'PyJWT[crypto]==2.15.1' 'flask-unsign==1.2.1'
/opt/venv/bin/python3 -m pip check

# The proxychains4 package does not provide the unversioned name on every image.
if ! command -v proxychains >/dev/null; then
    ln -s /usr/bin/proxychains4 /usr/local/bin/proxychains
fi

# 字典构建时解压，运行时直接读取。
if [ -f /usr/share/wordlists/rockyou.txt.gz ]; then
    gzip -df /usr/share/wordlists/rockyou.txt.gz
fi
test -s /usr/share/wordlists/rockyou.txt
chmod 0644 /usr/share/wordlists/rockyou.txt

# Stable, discoverable paths for small Web lists and existing larger resources.
mkdir -p /opt/ctf/share/wordlists
for list in common small; do
    test -s "/usr/share/dirb/wordlists/$list.txt"
    ln -sfn "/usr/share/dirb/wordlists/$list.txt" "/opt/ctf/share/wordlists/web-$list.txt"
done
test -s /usr/lib/python3/dist-packages/dirsearch/db/dicc.txt
ln -sfn /usr/lib/python3/dist-packages/dirsearch/db/dicc.txt /opt/ctf/share/wordlists/dirsearch.txt
ln -sfn /usr/share/wordlists/rockyou.txt /opt/ctf/share/wordlists/rockyou.txt

# IOActive's original requires Python 2. Pin and verify the Python 3 port,
# retain its MIT license, and apply the reviewed protocol compatibility fixes.
curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
    "https://codeload.github.com/lengkur/jdwp-shellifier/tar.gz/${jdwp_revision}" \
    -o "$toolchain_tmp/jdwp.tar.gz"
printf '%s  %s\n' "$jdwp_sha256" "$toolchain_tmp/jdwp.tar.gz" | sha256sum -c -
mkdir -p /opt/ctf/share/jdwp-shellifier
tar -xzf "$toolchain_tmp/jdwp.tar.gz" -C /opt/ctf/share/jdwp-shellifier --strip-components=1
patch --batch --fuzz=0 -d /opt/ctf/share/jdwp-shellifier -p1 < /opt/ctf/jdwp-shellifier.patch
printf '%s\n' "$jdwp_revision" > /opt/ctf/share/jdwp-shellifier/REVISION

# FRP is distributed as frpc (client) and frps (server), not a command named frp.
curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
    "https://github.com/fatedier/frp/releases/download/v${frp_version}/frp_${frp_version}_linux_amd64.tar.gz" \
    -o "$toolchain_tmp/frp.tar.gz"
printf '%s  %s\n' "$frp_sha256" "$toolchain_tmp/frp.tar.gz" | sha256sum -c -
tar -xzf "$toolchain_tmp/frp.tar.gz" -C "$toolchain_tmp" --strip-components=1 \
    "frp_${frp_version}_linux_amd64/frpc" "frp_${frp_version}_linux_amd64/frps"
install -m 0755 "$toolchain_tmp/frpc" "$toolchain_tmp/frps" /usr/local/bin/

apt-get clean
rm -rf /var/lib/apt/lists/*
