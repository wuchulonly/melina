"""Offline checks for the supplemental tools, run by ctf-check."""

import importlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


def run(*args, timeout=30, exit_codes=(0,), env=None, cwd=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, cwd=cwd)
    assert result.returncode in exit_codes, (args, result.returncode, result.stdout[-2000:], result.stderr[-2000:])
    return result.stdout + result.stderr


for directory in ("/tmp", "/var/tmp"):
    assert stat.S_IMODE(Path(directory).stat().st_mode) == 0o1777, directory
    with tempfile.TemporaryFile(dir=directory) as probe:
        probe.write(b"CTF_TEMP_OK")
print("Writable /tmp and /var/tmp: OK")

for module in (
    "flask_unsign_wordlist", "playwright.sync_api", "PIL.Image", "cv2", "pytesseract",
    "bs4", "lxml.etree", "gmpy2", "scapy.all", "impacket.smbconnection", "angr",
    "redis", "pydash",
):
    importlib.import_module(module)
    print(f"Python import {module}: OK")

# Built-in Flask secret lists must be readable by the actual unsign entry point.
from flask_unsign import DEFAULT_WORDLIST
from flask_unsign.helpers import wordlist

assert DEFAULT_WORDLIST and Path(DEFAULT_WORDLIST).is_file()
with wordlist(DEFAULT_WORDLIST) as words:
    assert next(iter(words))
print("flask-unsign bundled wordlists: OK")

for args in (
    ("sqlite3", "--version"), ("dig", "-v"),
    ("playwright", "--version"), ("tesseract", "--version"),
    ("ffmpeg", "-version"), ("convert", "-version"), ("magick", "-version"),
    ("Rscript", "--version"), ("whatweb", "--version"), ("wafw00f", "--help"),
    ("gobuster", "--help"), ("feroxbuster", "--help"), ("wfuzz", "--help"),
    ("jwt_tool", "-h"), ("binwalk", "--help"), ("exiftool", "-ver"),
    ("steghide", "--version"), ("hashid", "--help"), ("patator", "http_fuzz", "--help"),
    ("cewl", "--help"), ("crunch", "-h"), ("medusa", "-V"),
    ("subfinder", "-h"), ("katana", "-h"), ("commix", "--help"),
    ("dalfox", "--help"), ("arjun", "--help"), ("impacket-secretsdump", "-h"),
    ("mysql", "--version"), ("redis-cli", "--version"), ("sshpass", "-V"),
    ("go", "version"), ("7z", "i"), ("ruby", "--version"),
    ("wpscan", "--help"), ("psql", "--version"), ("jadx", "--version"),
    ("ltrace", "--version"),
):
    run(*args)
    print(f"{args[0]} argument parsing: OK")

# Hydra's help screen deliberately exits with 255; require its actual syntax.
assert "Syntax: hydra" in run("hydra", "-h", exit_codes=(255,))
print("hydra argument parsing: OK")

# enum4linux returns 1 for its help screen; require the help text, not just a file.
help_result = subprocess.run(["enum4linux", "-h"], capture_output=True, text=True, timeout=30)
assert help_result.returncode in (0, 1), help_result
assert "Usage:" in help_result.stdout + help_result.stderr, help_result
print("enum4linux argument parsing: OK")

assert "chi_sim" in run("tesseract", "--list-langs")
assert "eng" in run("tesseract", "--list-langs")
print("Tesseract English / Simplified Chinese language data: OK")

if "--smoke" not in sys.argv:
    sys.exit(0)

import cv2
import gmpy2
import numpy as np
import pytesseract
from bs4 import BeautifulSoup
from impacket import ntlm
from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright
from scapy.all import IP, TCP

assert gmpy2.invert(3, 11) == 4
assert gmpy2.powmod(2, 10, 1000) == 24
assert BeautifulSoup("<p id='probe'>CTF</p>", "lxml").select_one("#probe").text == "CTF"
assert etree.fromstring(b"<probe>CTF</probe>").text == "CTF"
packet = IP(dst="127.0.0.1") / TCP(dport=31337)
assert IP(bytes(packet))[TCP].dport == 31337
assert ntlm.compute_nthash("password").hex() == "8846f7eaee8fb117ad06bdd830b7586c"
print("HTML/XML parsing / GMP arithmetic / Scapy packet / Impacket NTLM: OK")

with tempfile.TemporaryDirectory(prefix="ctf-supplement-") as directory:
    root = Path(directory)
    db = root / "probe.db"
    output = run("sqlite3", str(db), "create table flags(value text); insert into flags values('CTF_SQLITE_OK'); select value from flags;")
    assert output.strip() == "CTF_SQLITE_OK", output
    print("sqlite3 local database roundtrip: OK")

    go_source = root / "probe.go"
    go_binary = root / "go-probe"
    go_source.write_text('package main\nimport "fmt"\nfunc main() { fmt.Print("CTF_GO_OK") }\n')
    run("go", "build", "-o", str(go_binary), str(go_source), timeout=120, env={**os.environ, "GOMAXPROCS": "2"})
    assert run(str(go_binary)) == "CTF_GO_OK"
    assert "CTF_RUBY_OK" in run("ruby", "-e", 'raise unless 6 * 7 == 42; puts "CTF_RUBY_OK"')
    print("Go payload compilation / Ruby execution: OK")

    archive_source = root / "archive.txt"
    archive_source.write_text("CTF_7ZIP_OK\n")
    archive = root / "probe.7z"
    extracted = root / "extracted"
    run("7z", "a", str(archive), str(archive_source))
    run("7z", "x", str(archive), "-o" + str(extracted))
    assert (extracted / "archive.txt").read_bytes() == archive_source.read_bytes()
    print("7z archive roundtrip: OK")

    image = Image.new("RGB", (400, 100), "white")
    ImageDraw.Draw(image).text((20, 10), "MELINA 742", font=ImageFont.load_default(size=48), fill="black")
    png = root / "ocr.png"
    image.save(png)
    loaded = cv2.imread(str(png))
    assert loaded.shape == (100, 400, 3)
    ok, encoded = cv2.imencode(".png", loaded)
    assert ok and np.array_equal(cv2.imdecode(encoded, cv2.IMREAD_COLOR), loaded)
    text = pytesseract.image_to_string(image, config="--psm 7", lang="eng")
    assert "MELINA" in text and "742" in text, repr(text)
    converted = root / "converted.png"
    run("convert", str(png), "-resize", "200x50!", str(converted))
    assert Image.open(converted).size == (200, 50)
    assert "200" in run("exiftool", "-ImageWidth", "-s3", str(converted))
    print("Pillow / OpenCV / OCR / ImageMagick / ExifTool image processing: OK")

    carrier = root / "carrier.wav"
    run("ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", "-c:a", "pcm_s16le", str(carrier))
    secret = root / "secret.txt"
    recovered = root / "recovered.txt"
    secret.write_text("CTF_STEGHIDE_OK\n")
    run("steghide", "embed", "-cf", str(carrier), "-ef", str(secret), "-p", "ctf-check", "-f")
    run("steghide", "extract", "-sf", str(carrier), "-xf", str(recovered), "-p", "ctf-check", "-f")
    assert recovered.read_bytes() == secret.read_bytes()
    print("FFmpeg audio / steghide roundtrip: OK")

    cookie = run("flask-unsign", "--sign", "--cookie", "{'ctf': True}", "--secret", "secret").strip()
    cracked = run("flask-unsign", "--unsign", "--cookie", cookie, "--threads", "1")
    assert "secret" in cracked, cracked
    print("flask-unsign default wordlist recovery: OK")

    jwt = importlib.import_module("jwt")
    token = jwt.encode({"ctf": "CTF_JWT_OK"}, "melina-ctf-check-secret-32-byte-key!!", algorithm="HS256")
    jwt_home = root / "jwt-home"
    jwt_home.mkdir()
    jwt_env = {**os.environ, "HOME": str(jwt_home)}
    # Upstream exits 1 after first-run setup; check setup and the following decode.
    assert "Configuration file built" in run("jwt_tool", token, env=jwt_env, exit_codes=(1,))
    decoded = run("jwt_tool", token, env=jwt_env, exit_codes=(1,))
    assert "CTF_JWT_OK" in decoded and "Traceback" not in decoded
    print("jwt_tool local JWT decoding: OK")

    with tempfile.TemporaryDirectory(dir="/tmp", prefix="ctf-angr-cache-") as cache:
        run("python3", "-c", "import angr, pathlib, tempfile; assert list(pathlib.Path(tempfile.gettempdir()).glob('pyvex_ffi_parser_cache.*')); print(angr.__version__)", env={**os.environ, "TMPDIR": cache}, timeout=60)
    print("angr / pyvex fresh temporary cache: OK")

    with sync_playwright() as playwright:
        assert Path(playwright.chromium.executable_path).is_file()
        browser = playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        page = browser.new_page()
        page.goto("data:text/html,<title>CTF_PLAYWRIGHT_OK</title><body><script>document.body.textContent=6*7</script></body>")
        assert page.title() == "CTF_PLAYWRIGHT_OK"
        assert page.locator("body").inner_text() == "42"
        browser.close()
    print("Playwright Python bundled Chromium / JavaScript execution: OK")

run("Rscript", "-e", 'stopifnot(sum(c(1, 2, 3)) == 6); cat("R_ARITHMETIC_OK\\n")')
print("Rscript arithmetic: OK")
