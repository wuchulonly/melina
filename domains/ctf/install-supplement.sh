#!/usr/bin/env bash
set -euo pipefail

test "$(dpkg --print-architecture)" = amd64
readonly jwt_revision=3bc7407cf2222d6a821dcc19c776e5a1b1cb9a9b
readonly jwt_sha256=9ba64c43d965b3e5119807354abbb50cd40212a8a41c5fef873875e87d72d76d

# Native Python caches (including pyvex) require an existing, writable temp dir.
install -d -m 1777 /tmp /var/tmp
supplement_tmp=$(mktemp -d)
trap 'rm -rf "$supplement_tmp"' EXIT

apt-get -o Acquire::Retries=3 update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    sqlite3 bind9-dnsutils hydra \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim ffmpeg imagemagick r-base-core \
    whatweb wafw00f gobuster feroxbuster wfuzz binwalk libimage-exiftool-perl steghide \
    hashid enum4linux patator cewl crunch medusa subfinder katana commix dalfox arjun \
    default-mysql-client redis-tools sshpass golang 7zip ruby \
    wpscan postgresql-client jadx ltrace

# Kali now ships modern 7zip; keep the command name used by existing solve scripts.
if ! command -v 7z >/dev/null; then
    ln -s /usr/bin/7zz /usr/local/bin/7z
fi

/opt/venv/bin/python3 -m pip install --no-cache-dir -r /opt/ctf/analysis-requirements.txt
/opt/venv/bin/python3 -m pip check

# Store Playwright's matching Chromium in the image, including the headless shell.
PLAYWRIGHT_BROWSERS_PATH=/opt/ctf/share/playwright \
    /opt/venv/bin/python3 -m playwright install chromium

# jwt_tool is not packaged in Kali. Retain the upstream license and pin its source.
curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
    "https://codeload.github.com/ticarpi/jwt_tool/tar.gz/${jwt_revision}" \
    -o "$supplement_tmp/jwt-tool.tar.gz"
printf '%s  %s\n' "$jwt_sha256" "$supplement_tmp/jwt-tool.tar.gz" | sha256sum -c -
mkdir -p /opt/ctf/share/jwt_tool
tar -xzf "$supplement_tmp/jwt-tool.tar.gz" -C /opt/ctf/share/jwt_tool --strip-components=1
# Python 3.14 validates delimiters in config keys, including upstream's comment keys.
patch --batch --fuzz=0 -d /opt/ctf/share/jwt_tool -p1 < /opt/ctf/jwt-tool.patch
printf '%s\n' "$jwt_revision" > /opt/ctf/share/jwt_tool/REVISION

apt-get clean
rm -rf /var/lib/apt/lists/*
