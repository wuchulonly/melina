#!/usr/bin/env bash
set -euo pipefail

# Prepare everything while building; branches may have no route to package indexes.
readonly runtime=/opt/ctf/python/3.11.16
readonly bundles=/opt/ctf/share/python-offline
readonly python_sha256=64427febea27864d136db46c8efe968eb6fa5ca2813ce1dca4bb95aec31cb2e4
offline_tmp=$(mktemp -d)
trap 'rm -rf "$offline_tmp"' EXIT
curl -fL --retry 3 --connect-timeout 20 --max-time 300 \
    'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.11.16%2B20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz' \
    -o "$offline_tmp/python.tar.gz"
printf '%s  %s\n' "$python_sha256" "$offline_tmp/python.tar.gz" | sha256sum -c -
mkdir -p "$runtime" /opt/ctf/envs
tar -xzf "$offline_tmp/python.tar.gz" -C "$runtime" --strip-components=1

for environment in pydash-8.1.0 gradio-4.12.0; do
    bundle="$bundles/$environment"
    mkdir -p "$bundle/wheels"
    "$runtime/bin/python3.11" -m pip --isolated download --disable-pip-version-check \
        --only-binary=:all: --require-hashes --dest "$bundle/wheels" -r "$bundle/requirements.txt"
    "$runtime/bin/python3.11" -m venv "/opt/ctf/envs/$environment"
    "/opt/ctf/envs/$environment/bin/python" -m pip --isolated install \
        --disable-pip-version-check --no-index --no-cache-dir --require-hashes \
        --find-links "$bundle/wheels" -r "$bundle/requirements.txt"
    "/opt/ctf/envs/$environment/bin/python" -m pip check
done

# Keep source and license metadata in the installed packages, with wheels for
# creating a writable per-task environment offline. Do not modify the main venv.
