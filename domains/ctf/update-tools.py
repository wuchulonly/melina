#!/usr/bin/python3
"""Install the checked upstream tool releases; reuse only verified cached assets."""
from pathlib import Path
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path("/opt/ctf")


def asset(spec, scratch):
    cached = Path(os.environ.get("CTF_TOOL_CACHE", "/var/cache/ctf-tools")) / spec["archive"]
    archive = cached if cached.is_file() else scratch / spec["archive"]
    if not archive.exists():
        request = urllib.request.Request(spec["url"], headers={"User-Agent": "Melina-CTF-refresh"})
        with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != spec["sha256"]:
        raise RuntimeError(f"checksum mismatch: {spec['archive']}")
    return archive


def unpack(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                target = (destination / item.filename).resolve()
                if not target.is_relative_to(destination.resolve()):
                    raise RuntimeError("archive path escapes the tool directory")
            bundle.extractall(destination)
            for item in bundle.infolist():
                mode = (item.external_attr >> 16) & 0o777
                if mode and not item.is_dir():
                    (destination / item.filename).chmod(mode)
    elif archive.name.endswith((".tar.gz", ".tgz", ".tar.xz", ".tar.bz2")):
        with tarfile.open(archive) as bundle:
            bundle.extractall(destination, filter="data")
    else:
        with gzip.open(archive, "rb") as source, (destination / archive.stem).open("wb") as output:
            shutil.copyfileobj(source, output)


def install_sources(lock, installed, scratch):
    for name, spec in lock.get("sources", {}).items():
        if installed.get("sources", {}).get(name) == spec and (ROOT / "share" / name).is_dir():
            print(f"{name}: {spec['version']} (already installed)", flush=True)
            continue
        expanded = scratch / (name + "-source")
        unpack(asset(spec, scratch), expanded)
        roots = [path for path in expanded.iterdir() if path.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f"unexpected source layout for {name}")
        target = ROOT / "share" / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(roots[0], target)
        if name == "sqlmap":
            wrapper = Path("/usr/local/bin/sqlmap")
            wrapper.write_text('#!/bin/sh\nexec /usr/bin/python3 /opt/ctf/share/sqlmap/sqlmap.py "$@"\n')
            wrapper.chmod(0o755)
        elif name == "nmap":
            prefix = ROOT / "share" / "nmap-runtime" / spec["version"]
            build_log = scratch / "nmap-build.log"
            with build_log.open("w") as output:
                for command in (["./configure", "--prefix=" + str(prefix), "--without-zenmap"],
                                ["make", "-j2"], ["make", "install"]):
                    result = subprocess.run(command, cwd=target, stdout=output, stderr=subprocess.STDOUT)
                    if result.returncode:
                        output.flush()
                        raise RuntimeError("Nmap build failed: " + build_log.read_text()[-4000:])
            for binary in ("nmap", "ncat", "nping", "ndiff"):
                source = prefix / "bin" / binary
                if source.is_file():
                    link = Path("/usr/local/bin") / binary
                    link.unlink(missing_ok=True)
                    link.symlink_to(source)
            # Keep the versioned binaries and data; compiler products are disposable.
            for license_file in target.rglob("*"):
                if license_file.is_file() and license_file.name.lower().startswith(("license", "copying")):
                    destination = ROOT / "share" / "licenses" / name / license_file.relative_to(target)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(license_file, destination)
            shutil.rmtree(target)
            target.mkdir()
            (target / "REVISION").write_text(spec["version"] + "\n")
        print(f"{name}: {spec['version']}", flush=True)


def install_custom_templates():
    # 上游库更新会替换整个目录；随后重新同步补充模板，供同一入口检索。
    source = ROOT / "share" / "nuclei-custom" / "http"
    target = ROOT / "share" / "nuclei-templates" / "http" / "custom"
    if not source.is_dir():
        raise RuntimeError(f"missing custom Nuclei templates: {source}")
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def main():
    lock = json.loads((ROOT / "toolchain.lock.json").read_text())
    stamp = ROOT / "versions.lock.json"
    installed = json.loads(stamp.read_text()) if stamp.exists() else {}
    with tempfile.TemporaryDirectory(prefix="ctf-refresh-") as directory:
        scratch = Path(directory)
        for name, spec in lock["tools"].items():
            if installed.get("tools", {}).get(name) == spec:
                print(f"{name}: {spec['version']} (already installed)", flush=True)
                continue
            archive = asset(spec, scratch)
            if archive.name.endswith(".deb"):
                subprocess.run(["dpkg", "-i", str(archive)], check=True)
            else:
                expanded = scratch / name
                unpack(archive, expanded)
                if name in {"ghidra", "go"}:
                    roots = [path for path in expanded.iterdir() if path.is_dir()]
                    if len(roots) != 1:
                        raise RuntimeError(f"unexpected release layout for {name}")
                    target = ROOT / "share" / name / spec["version"]
                    if target.exists():
                        shutil.rmtree(target)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(roots[0], target)
                    if name == "ghidra":
                        system_path = Path("/usr/share/ghidra")
                        if system_path.is_symlink():
                            system_path.unlink()
                        elif system_path.exists():
                            shutil.rmtree(system_path)
                        system_path.symlink_to(target, target_is_directory=True)
                    else:
                        for binary in ("go", "gofmt"):
                            link = Path("/usr/local/bin") / binary
                            link.unlink(missing_ok=True)
                            link.symlink_to(target / "bin" / binary)
                for binary in spec["binaries"]:
                    matches = [path for path in expanded.rglob(binary) if path.is_file()]
                    if len(matches) != 1:
                        raise RuntimeError(f"ambiguous or missing binary: {name}/{binary}")
                    target = ROOT / "bin" / binary if name == "nuclei" else Path("/usr/local/bin") / binary
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(matches[0], target)
                    target.chmod(0o755)
                for license_file in expanded.rglob("*"):
                    if license_file.is_file() and license_file.name.lower().startswith(("license", "copying")):
                        target = ROOT / "share" / "licenses" / name / license_file.relative_to(expanded)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(license_file, target)
            print(f"{name}: {spec['version']}", flush=True)
        install_sources(lock, installed, scratch)
        install_custom_templates()
    subprocess.run(["/opt/venv/bin/python3", "-m", "pip", "install", "--quiet", "--no-cache-dir", "-r", str(ROOT / "analysis-requirements.txt")], check=True)
    subprocess.run(["/opt/venv/bin/python3", "-m", "pip", "check"], check=True)
    # Python HTTPX's optional CLI shadows ProjectDiscovery's scanner in PATH.
    # Keep the Python API, and reserve the existing httpx command for the scanner.
    Path("/opt/venv/bin/httpx").unlink(missing_ok=True)
    subprocess.run(["npm", "install", "-g", "--no-fund", "--no-audit", "@playwright/cli@" + lock["playwright_cli"]], check=True)
    subprocess.run(["/opt/venv/bin/python3", "-m", "playwright", "install", "chromium"], check=True)
    subprocess.run(["npm", "cache", "clean", "--force"], check=True)
    (ROOT / "versions.lock.json").write_text(json.dumps(lock, indent=2) + "\n")


if __name__ == "__main__":
    main()
