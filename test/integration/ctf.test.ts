// CTF 领域实测：必须在实际服务账号的 rootless 引擎里有原生镜像，全部检查在无外网容器里运行。
// MELINA_REQUIRE_CTF_TESTS=1 node_modules/.bin/vitest run
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceExec } from '../../src/api/assemble.ts';
import { DEFAULT_GLOBAL_CONFIG } from '../../src/core/config.ts';
import type { ContainerRef, ContainerSpec } from '../../src/core/interfaces/container.ts';
import { ContainerBranchEnv, runtimePaths } from '../../src/runtime/branch-env.ts';
import { detectEngine, PodmanRuntime } from '../../src/tools/container.ts';
import { DomainImages } from '../../src/tools/container-images.ts';
import { SecretRedactor } from '../../src/tools/redact.ts';
import { makeRun } from './workspace/helpers.ts';

const required = process.env.MELINA_REQUIRE_CTF_TESTS === '1';
const root = mkdtempSync(join(tmpdir(), 'melina-ctf-it-'));
const workspace = join(root, 'workspace');
const materials = join(root, 'materials');
mkdirSync(workspace);
mkdirSync(materials);
writeFileSync(join(materials, 'attachment.txt'), 'CTF_ATTACHMENT_OK\n');
const engine = detectEngine();
const images = new DomainImages(fileURLToPath(new URL('../../domains/', import.meta.url)));
const runtime = engine
  ? new PodmanRuntime({
      engine,
      images,
      redactor: new SecretRedactor(),
      network: 'none',
      memoryMax: 4 * 1024 ** 3,
      pidsMax: 512,
    })
  : undefined;
let container: ContainerRef | undefined;
let spec: ContainerSpec;

beforeAll(async () => {
  if (!required) return;
  if (!runtime) throw new Error('CTF 检查要求 rootless 容器引擎');
  const info = await runtime.probe();
  expect(info.rootless).toBe(true);
  expect(info.memoryLimit).toBe(true);
  expect(info.pidsLimit).toBe(true);
  expect(await runtime.checkImages(['ctf'])).toEqual([{ domain: 'ctf', image: images.imageFor('ctf'), present: true }]);
  spec = {
    name: `melina-ctf-it-${randomBytes(5).toString('hex')}`,
    domain: 'ctf',
    workspace: { host: workspace, container: '/workspace', readOnly: false },
    materialsDir: materials,
    credentials: [],
  };
  container = await runtime.start({ ...spec, domain: 'general' });
}, 120_000);

afterAll(async () => {
  if (container) await runtime?.remove(container);
  rmSync(root, { recursive: true, force: true });
}, 120_000);

async function sh(cmd: string, timeoutMs = 60_000) {
  if (!container || !runtime) throw new Error('CTF 容器没启动');
  return runtime.exec(container, { cmd, timeoutMs });
}

describe.skipIf(!required)('Melina 的原生 CTF 环境', () => {
  it('CTF 任务的 Scoper 和 setup 使用领域镜像，strings 可用', async () => {
    if (!runtime) throw new Error('CTF 检查要求 rootless 容器引擎');
    const scoperWorkspace = join(root, 'scoper');
    mkdirSync(scoperWorkspace);
    const task = makeRun({ root: scoperWorkspace, kind: 'dir-copy' });
    task.goal.domain = 'ctf';
    const domains = ['general', 'ctf'];
    const env = new ContainerBranchEnv({
      runtime,
      paths: runtimePaths(root),
      credentials: () => [],
      domains: () => domains,
    });
    const scoper = await env.scoper(task, scoperWorkspace);
    if (!scoper) throw new Error('Scoper 容器没有启动');
    const probe =
      "set -o pipefail; grep '^ID=kali' /etc/os-release && printf '\\000CTF_STRINGS_OK\\000' | strings -n 3";
    try {
      const inspected = await runtime.exec(scoper, { cmd: probe, timeoutMs: 30_000 });
      expect(inspected.exitCode, inspected.output).toBe(0);
      expect(inspected.output).toContain('CTF_STRINGS_OK');

      const write = await runtime.exec(scoper, { cmd: 'touch /workspace/scoper-write-probe', timeoutMs: 30_000 });
      expect(write.exitCode, write.output).not.toBe(0);
      expect(write.output).toMatch(/Read-only file system/);

      const setup = workspaceExec({
        containers: runtime,
        queries: { getRun: (id) => (id === task.id ? task : undefined) },
        config: { credentials: () => [], global: () => ({ ...DEFAULT_GLOBAL_CONFIG, domains }) },
      });
      const prepared = await setup(
        { path: scoperWorkspace, runId: task.id },
        ['bash', '-lc', `${probe} && touch /workspace/setup-write-probe`],
        { timeoutMs: 30_000 },
      );
      expect(prepared.exitCode, prepared.stdout).toBe(0);
      expect(prepared.stdout).toContain('CTF_STRINGS_OK');
    } finally {
      await env.removeScoper(task.id, true);
    }
  });

  it('先启动的通用分支能切换到 CTF 镜像，工作区文件保留', async () => {
    const initial = container;
    const saved = await sh('printf CTF_WORKSPACE_OK > /workspace/retained.txt; printf old > /opt/general-only');
    expect(saved.exitCode, saved.output).toBe(0);
    container = await runtime?.start(spec);
    expect(container?.id).not.toBe(initial?.id);
    const result = await sh(
      'cat /workspace/retained.txt; test ! -e /opt/general-only && grep "^ID=kali" /etc/os-release',
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('CTF_WORKSPACE_OK');
    expect(result.output).toContain('ID=kali');
  });

  it('登录 shell 使用分析 venv，附件和环境参考从 Melina 的目录可读', async () => {
    const result = await sh(
      'test "$(id -u)" = 0 && test "$(command -v python3)" = /opt/venv/bin/python3 && test "$PWD" = /workspace && test "$CTF_REFERENCE" = /melina/ctf/README.md && test -s "$CTF_REFERENCE" && test -s /melina/materials/attachment.txt && git config --system --get user.name',
    );
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('Melina');
  });

  it('容器可冻结，满足 Melina 的 snapshot 条件', async () => {
    expect(await runtime?.checkFreeze(['ctf'])).toEqual({ ok: true });
  }, 120_000);

  it('离线创建环境拒绝越界路径和覆盖现有内容', async () => {
    const result = await sh(
      'mkdir -p /workspace/existing && printf sentinel > /workspace/existing/sentinel; ctf-python create pydash /workspace/existing >/tmp/existing.log 2>&1; existing_rc=$?; ctf-python create pydash /tmp/ctf-outside >/tmp/outside.log 2>&1; outside_rc=$?; test "$existing_rc" = 2 && test "$outside_rc" = 2 && test "$(cat /workspace/existing/sentinel)" = sentinel && test ! -e /tmp/ctf-outside',
    );
    expect(result.exitCode, result.output).toBe(0);
  });

  it('默认 Gradio 可在只读工作区实例化，仍允许显式启用 flagging', async () => {
    if (!runtime) throw new Error('CTF 检查要求 rootless 容器引擎');
    const probe = await runtime.ephemeral({
      ...spec,
      name: `${spec.name}-gradio-readonly`,
      workspace: { ...spec.workspace, readOnly: true },
    });
    try {
      const result = await runtime.exec(probe, {
        cmd: `set -eu
test "$PWD" = /workspace
# Unset the image default to exercise ctf-python's own fallback.
env -u GRADIO_ALLOW_FLAGGING ctf-python run gradio - <<'PY'
import os
from pathlib import Path
import gradio as gr

assert os.statvfs('.').f_flag & os.ST_RDONLY
interface = gr.Interface(fn=lambda value: value, inputs='text', outputs='text')
assert interface.allow_flagging == 'never'
assert not Path('flagged').exists()
print('Gradio default in read-only cwd: OK')
PY
# The caller can opt in and choose a writable destination.
GRADIO_ALLOW_FLAGGING=manual ctf-python run gradio - <<'PY'
from pathlib import Path
from tempfile import TemporaryDirectory
import gradio as gr

with TemporaryDirectory() as directory:
    flags = Path(directory) / 'flags'
    interface = gr.Interface(fn=lambda value: value, inputs='text', outputs='text', flagging_dir=str(flags))
    assert interface.allow_flagging == 'manual'
    assert flags.is_dir()
print('Gradio explicit flagging in writable directory: OK')
PY
# Self-checks must also work when the caller enables flagging.
GRADIO_ALLOW_FLAGGING=manual bash /opt/ctf/check-offline-python.sh
test ! -e /workspace/flagged`,
        timeoutMs: 120_000,
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('Gradio default in read-only cwd: OK');
      expect(result.output).toContain('Gradio explicit flagging in writable directory: OK');
      expect(result.output).toContain('Gradio 4.12.0 config / prediction / local source: OK');
    } finally {
      await runtime.remove(probe);
    }
  }, 150_000);

  it('快速检查拒绝系统 Python，并一次报告多个缺失模块', async () => {
    const incorrect = await sh('PATH=/usr/bin:/bin /usr/local/bin/ctf-check --quick');
    expect(incorrect.exitCode, incorrect.output).not.toBe(0);
    expect(incorrect.output).toContain('default python3 must use /opt/venv');
    const broken = await sh(`scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
printf 'raise ImportError("CTF_MISSING_HTTP")\\n' > "$scratch/aiohttp.py"
printf 'raise ImportError("CTF_MISSING_TERMINAL")\\n' > "$scratch/pexpect.py"
printf '#!/bin/sh\\nprintf "WRONG_HTTPX_CLI\\\\n"\\n' > "$scratch/httpx"
chmod +x "$scratch/httpx"
PATH="$scratch:$PATH" PYTHONPATH="$scratch" ctf-check --quick`);
    expect(broken.exitCode, broken.output).not.toBe(0);
    expect(broken.output).toContain('Python aiohttp: ImportError: CTF_MISSING_HTTP');
    expect(broken.output).toContain('Python pexpect: ImportError: CTF_MISSING_TERMINAL');
    expect(broken.output).toContain('WRONG_HTTPX_CLI');
    expect(broken.output).not.toContain('CTF quick check: OK');
  }, 150_000);

  it('只读工作区中无外网完成离线 Python、口令恢复、浏览器、协议和逆向自检', async () => {
    if (!runtime) throw new Error('CTF 检查要求 rootless 容器引擎');
    const probe = await runtime.ephemeral({
      ...spec,
      name: `${spec.name}-toolchain-readonly`,
      workspace: { ...spec.workspace, readOnly: true },
    });
    let result: Awaited<ReturnType<typeof sh>>;
    try {
      result = await runtime.exec(probe, { cmd: 'ctf-check --smoke', timeoutMs: 600_000 });
    } finally {
      await runtime.remove(probe);
    }
    expect(result.exitCode, result.output).toBe(0);
    for (const marker of [
      'Bundled wheel dependencies / fresh offline venvs: OK',
      'hashcat / john offline recovery: OK',
      'Chromium headless page: OK',
      'Playwright CLI local browser navigation: OK',
      'CTF capabilities:',
      'Python telnetlib / pexpect interactive exchange: OK',
      'aiohttp / HTTPX sync and async local HTTP exchange: OK',
      'websocket-client / websockets local text and binary exchange: OK',
      'GNU time / traceroute loopback execution: OK',
      'gdb child-process debugging: OK',
      'angr ELF symbolic execution: value=112, OK',
      'Writable /tmp and /var/tmp: OK',
      'flask-unsign default wordlist recovery: OK',
      'Pillow / OpenCV / OCR / ImageMagick / ExifTool image processing: OK',
      'FFmpeg audio / steghide roundtrip: OK',
      'Playwright Python bundled Chromium / JavaScript execution: OK',
      'angr / pyvex fresh temporary cache: OK',
      'Go payload compilation / Ruby execution: OK',
      '7z archive roundtrip: OK',
      'CTF toolchain: OK',
    ]) {
      expect(result.output, marker).toContain(marker);
    }
  }, 660_000);
});
