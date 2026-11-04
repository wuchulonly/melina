"""Check the supported CTF capabilities through the branch's default interpreter."""

import importlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    manifest = json.loads(Path(__file__).with_name("capabilities.json").read_text())
    failures = []
    print(f"[ctf-check] python={sys.executable} prefix={sys.prefix} base_prefix={sys.base_prefix}", flush=True)
    if sys.prefix != "/opt/venv":
        failures.append("default python3 must use /opt/venv; check PATH and shell profiles")

    for command in manifest["commands"]:
        path = shutil.which(command)
        if path is None:
            failures.append(f"command {command}: missing or not executable")

    for module in manifest["python_modules"]:
        try:
            importlib.import_module(module)
        except Exception as error:
            failures.append(f"Python {module}: {type(error).__name__}: {error}")

    # Detect same-name executables with incompatible APIs, not just PATH presence.
    for probe in manifest["command_probes"]:
        try:
            result = subprocess.run(probe["argv"], text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=10)
            if result.returncode or probe["output_contains"] not in result.stdout:
                failures.append(f"command API {probe['argv']}: exit={result.returncode}: {result.stdout[-500:]}")
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(f"command API {probe['argv']}: {type(error).__name__}: {error}")

    # Report every gap in one pass; the first missing dependency must not hide others.
    if failures:
        for failure in failures:
            print(f"[ctf-check] FAIL {failure}", flush=True)
        raise SystemExit(f"CTF capabilities: {len(failures)} failure(s)")
    print(f"CTF capabilities: {len(manifest['commands'])} commands, "
          f"{len(manifest['python_modules'])} Python imports: OK", flush=True)


if __name__ == "__main__":
    main()
