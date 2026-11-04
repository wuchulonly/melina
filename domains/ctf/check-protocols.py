"""Offline workflow checks; all listeners bind only to container loopback."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import asyncio
import json
import os
from pathlib import Path
import re
import socketserver
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET


def run(*args, **kwargs):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=40, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}):\n{result.stdout}")
    return result.stdout


@contextmanager
def serve(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def check_ffuf(directory):
    common = Path(run("ctf-wordlists", "web-common").strip())
    assert "admin" in common.read_text().splitlines(), "Missing common Web paths"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"local toolchain fixture"
            self.send_response(200 if self.path == "/admin" else 404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    words = directory / "web.txt"
    words.write_text("admin\nking-ctf-path-does-not-exist\n")
    output = directory / "ffuf.json"
    with serve(ThreadingHTTPServer(("127.0.0.1", 0), Handler)) as port:
        run("ffuf", "-noninteractive", "-s", "-w", str(words), "-u",
            f"http://127.0.0.1:{port}/FUZZ", "-mc", "200", "-t", "1",
            "-timeout", "3", "-maxtime", "10", "-of", "json", "-o", str(output))
    matches = json.loads(output.read_text())["results"]
    assert len(matches) == 1 and matches[0]["url"].endswith("/admin"), matches
    print("ffuf local HTTP discovery and JSON output: OK", flush=True)


def check_browser(directory):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"<html><title>CTF_PLAYWRIGHT_OK</title><body>local fixture</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    session = f"-s=ctf-check-{os.getpid()}"
    with serve(ThreadingHTTPServer(("127.0.0.1", 0), Handler)) as port:
        try:
            run("playwright-cli", session, "open", f"http://127.0.0.1:{port}/",
                "--config=/opt/ctf/playwright.json", cwd=directory)
            title = run("playwright-cli", session, "eval", "() => document.title", cwd=directory)
            assert "CTF_PLAYWRIGHT_OK" in title, title
        finally:
            run("playwright-cli", session, "close", cwd=directory)
    print("Playwright CLI local browser navigation: OK", flush=True)


def check_telnet():
    import pexpect
    import telnetlib

    received = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(10)
            # WILL SUPPRESS-GO-AHEAD exercises Telnet option negotiation.
            self.request.sendall(b"\xff\xfb\x03CTF_TELNET_READY\r\n")
            data = b""
            while b"melina-ctf\r" not in data:
                chunk = self.request.recv(1024)
                if not chunk:
                    raise EOFError("Telnet client disconnected")
                data += chunk
            received.append(data)
            self.request.sendall(b"CTF_TELNET_OK\r\n")

    with serve(socketserver.TCPServer(("127.0.0.1", 0), Handler)) as port:
        output = run("expect", "-c", rf"""
set timeout 10
spawn telnet 127.0.0.1 {port}
expect {{
    "CTF_TELNET_READY" {{}}
    timeout {{exit 1}}
    eof {{exit 1}}
}}
send -- "melina-ctf\r"
expect {{
    "CTF_TELNET_OK" {{}}
    timeout {{exit 1}}
    eof {{exit 1}}
}}
expect eof
set status [wait]
exit [lindex $status 3]
""")
        # Exercise the APIs used by existing Python scripts through default python3.
        with telnetlib.Telnet("127.0.0.1", port, timeout=5) as client:
            assert b"CTF_TELNET_READY" in client.read_until(b"CTF_TELNET_READY\r\n", timeout=5)
            client.write(b"melina-ctf\r\n")
            assert b"CTF_TELNET_OK" in client.read_until(b"CTF_TELNET_OK\r\n", timeout=5)
        child = pexpect.spawn("telnet", ["127.0.0.1", str(port)], encoding="utf-8", timeout=5)
        try:
            child.expect_exact("CTF_TELNET_READY")
            child.send("melina-ctf\r")
            child.expect_exact("CTF_TELNET_OK")
            child.expect(pexpect.EOF)
        finally:
            child.close(force=True)
        assert child.exitstatus == 0, (child.exitstatus, child.signalstatus)
    assert "CTF_TELNET_OK" in output and received, output
    assert b"\xff\xfd\x03" in received[0], received
    assert len(received) == 3, received
    assert b"\xff\xfe\x03" in received[1], received
    print("Telnet negotiation / expect interactive exchange: OK", flush=True)
    print("Python telnetlib / pexpect interactive exchange: OK", flush=True)


def check_python_http():
    import aiohttp
    import httpx

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    payload = {"probe": "CTF_HTTP_OK"}
    with serve(ThreadingHTTPServer(("127.0.0.1", 0), Handler)) as port:
        url = f"http://127.0.0.1:{port}/"
        with httpx.Client(trust_env=False, timeout=5) as client:
            response = client.post(url, json=payload)
            assert response.status_code == 200 and response.json() == payload

        async def clients():
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5), trust_env=False) as client:
                async with client.post(url, json=payload) as response:
                    assert response.status == 200 and await response.json() == payload
            async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
                response = await client.post(url, json=payload)
                assert response.status_code == 200 and response.json() == payload

        asyncio.run(clients())
    print("aiohttp / HTTPX sync and async local HTTP exchange: OK", flush=True)


def check_python_websocket():
    import websocket
    from websockets.sync.client import connect
    from websockets.sync.server import serve as websocket_server

    def echo(connection):
        for message in connection:
            connection.send(message)

    with websocket_server(echo, "127.0.0.1", 0) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"ws://127.0.0.1:{server.socket.getsockname()[1]}/"
            with connect(url, open_timeout=5, close_timeout=5, proxy=None) as client:
                client.send("CTF_WS_OK")
                assert client.recv(timeout=5) == "CTF_WS_OK"
            client = websocket.create_connection(url, timeout=5, http_no_proxy=["127.0.0.1"])
            try:
                client.send_binary(b"CTF_WS_OK\x00\xff")
                assert client.recv() == b"CTF_WS_OK\x00\xff"
            finally:
                client.close()
        finally:
            server.shutdown()
            worker.join(timeout=5)
    print("websocket-client / websockets local text and binary exchange: OK", flush=True)


def check_nmap():
    assert os.environ.get("NMAP_UNPRIVILEGED") == "1", "Nmap must default to unprivileged mode"

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            pass

    # Exercise the default scan selection used by existing commands, without -sT.
    # Root in a container may lack CAP_NET_RAW; this must still use connect().
    with serve(socketserver.TCPServer(("127.0.0.1", 0), Handler)) as port:
        output = run("nmap", "-Pn", "-n", "-p", str(port), "--host-timeout", "5s",
                     "-oX", "-", "127.0.0.1")
    scan = ET.fromstring(output)
    assert scan.find("scaninfo").get("type") == "connect", output
    assert scan.find(f"host/ports/port[@portid='{port}']/state").get("state") == "open", output
    print("Nmap unprivileged default / loopback TCP connect scan: OK", flush=True)


def check_network_basics():
    output = run("/usr/bin/time", "-f", "CTF_TIME_EXIT=%x", "/bin/true")
    assert "CTF_TIME_EXIT=0" in output, output
    run("traceroute", "-n", "-m", "1", "-w", "1", "127.0.0.1")
    print("GNU time / traceroute loopback execution: OK", flush=True)


@contextmanager
def jvm(directory):
    log_path = directory / "jvm.log"
    with log_path.open("w") as log:
        process = subprocess.Popen([
            "java", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0",
            "-cp", str(directory), "ToolchainJdwpProbe",
        ], stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                output = log_path.read_text()
                match = re.search(r"Listening for transport dt_socket at address: (\d+)", output)
                if match and "CTF_JVM_READY" in output:
                    yield match[1]
                    return
                if process.poll() is not None:
                    raise RuntimeError(f"Test JVM exited:\n{output}")
                time.sleep(0.05)
            raise RuntimeError(f"Test JVM did not become ready:\n{log_path.read_text()}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def check_jdwp(directory):
    source = directory / "ToolchainJdwpProbe.java"
    source.write_text("""
public class ToolchainJdwpProbe {
    public static volatile int marker = 112;
    public static void tick() { marker = 112; }
    public static void main(String[] args) throws Exception {
        Runtime.getRuntime();
        tick();
        System.out.println("CTF_JVM_READY");
        while (true) { tick(); Thread.sleep(50); }
    }
}
""")
    run("javac", "-g", str(source))
    with jvm(directory) as port:
        output = run("expect", "-c", rf"""
set timeout 15
proc prompt {{}} {{
    expect {{
        -re {{> |main\[[0-9]+\] }} {{}}
        timeout {{exit 1}}
        eof {{exit 1}}
    }}
}}
spawn jdb -attach 127.0.0.1:{port}
prompt
send -- "stop in ToolchainJdwpProbe.tick\r"
expect {{
    "Breakpoint hit:" {{}}
    -re {{> |main\[[0-9]+\] }} {{
        send -- "cont\r"
        expect {{ "Breakpoint hit:" {{}} timeout {{exit 1}} eof {{exit 1}} }}
    }}
    timeout {{exit 1}}
    eof {{exit 1}}
}}
prompt
send -- "print ToolchainJdwpProbe.marker\r"
expect {{ " = 112" {{}} timeout {{exit 1}} eof {{exit 1}} }}
prompt
send -- "clear ToolchainJdwpProbe.tick\r"
prompt
send -- "cont\r"
prompt
send -- "exit\r"
expect eof
set status [wait]
exit [lindex $status 3]
""")
        assert " = 112" in output, output
    print("jdb attach / breakpoint / field inspection: OK", flush=True)

    with jvm(directory) as port:
        output = run("jdwp-shellifier", "-t", "127.0.0.1", "-p", port,
                     "--break-on", "ToolchainJdwpProbe.tick")
        assert "Found Java Runtime Environment version" in output, output
        assert "Command successfully executed" in output, output

    # Let a running JVM hit the breakpoint while its registration is returning.
    # An unconditional Resume after Set used to release that suspension, causing
    # INVALID_THREAD during invocation. Exercise real packets, not just --help.
    with jvm(directory) as port:
        output = run("python3", "-c", """
import runpy
import sys
import time
from types import SimpleNamespace

module = runpy.run_path('/opt/ctf/share/jdwp-shellifier/jdwp-shellifier.py')

class SlowEventClient(module['JDWPClient']):
    def send_event(self, *args):
        result = super().send_event(*args)
        time.sleep(0.25)
        return result

client = SlowEventClient('127.0.0.1', int(sys.argv[1]))
args = SimpleNamespace(target='127.0.0.1', port=int(sys.argv[1]),
                       break_on='ToolchainJdwpProbe.tick',
                       break_on_class='LToolchainJdwpProbe;',
                       break_on_method='tick', cmd=None, no_wait=False)
try:
    client.start()
    if not module['runtime_exec'](client, args):
        raise RuntimeError('JVM property inspection failed')
finally:
    if hasattr(client, 'socket'):
        client.leave()
""", port)
        assert "Found Java Runtime Environment version" in output, output
        assert "Command successfully executed" in output, output
    print("jdwp-shellifier breakpoint timing: OK", flush=True)

    with jvm(directory) as port:
        marker = directory / "jdwp-command-ran"
        output = run("jdwp-shellifier", "-t", "127.0.0.1", "-p", port,
                     "--break-on", "ToolchainJdwpProbe.tick", "--no-wait",
                     "--cmd", f"/usr/bin/touch {marker}")
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists(), output
    print("jdwp-shellifier JVM properties / verified command execution: OK", flush=True)


if __name__ == "__main__":
    # Executable and native-library scratch belongs in the private HOME.
    with tempfile.TemporaryDirectory(prefix="ctf-protocol-check-", dir=os.environ["HOME"]) as scratch:
        directory = Path(scratch)
        check_ffuf(directory)
        check_browser(directory)
        check_telnet()
        check_python_http()
        check_python_websocket()
        check_nmap()
        check_network_basics()
        check_jdwp(directory)
