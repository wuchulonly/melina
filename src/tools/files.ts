// read、edit、write：只能操作本 workspace 里的文件，read 也能读 /melina 下的只读目录（附件、原始输出、后台日志）。
// 三个都在调用方的容器里执行，不在宿主机上碰 workspace：路径和符号链接都在容器的挂载命名空间里解析，只读挂载由容器保证，
// workspace 里 agent 放的符号链接碰不到宿主机上的文件。
// 文件内容不经过输出回传再写回去：输出会脱敏，读回来再写会把文件里的凭证值改成占位符。edit 用容器里的 python3 原地替换，
// write 用 base64 把内容原样写进去。

import type { ContainerExecResult } from '../core/interfaces/container.ts';
import type { ToolOutcome } from '../core/interfaces/gateway.ts';
import type { EditArgs, ReadArgs, WriteArgs } from '../core/tools.ts';
import { outputInspector } from './extensions.ts';
import { observe } from './observe.ts';
import { base64Lines, containerPath, displayPath, shQuote } from './paths.ts';
import { fail, messageOf, type ToolEnv, toolSlot } from './session.ts';
import { formatBytes, preview, splitLines } from './summary.ts';

/** 不给 limit 时最多读多少行；要看别的部分用 offset、limit */
export const READ_DEFAULT_LINES = 2000;
/** 超过这么大的文件不数行数（awk 数 1 GB 的文件要好几秒） */
const COUNT_LINES_MAX_BYTES = 64 * 1024 * 1024;
/**
 * 一次 read 最多取回多少字节，在整行处停下：容器运行时把超过 4 MiB 的输出掐掉中间一段，
 * 掐过的内容再按行编号，行号和「接着读」的位置都会错。一次取 1 MiB 以内，行号由脚本报出来
 */
export const READ_MAX_BYTES = 1024 * 1024;

// ── read ──────────────────────────────────────────────────────────────────

/**
 * 输出：第一行 `MELINA-READ <状态> <字段…>`；ok 时接着是从 offset 起的内容，最后一行 `MELINA-READ-END <最后一行的行号> <这一行是否截过>`。
 * 不用 exit：命令文件由登录 shell 执行，exit 会跑 ~/.bash_logout，它的输出会混进文件内容。awk 用 LC_ALL=C，长度按字节算。
 */
export function readScript(path: string, offset: number, limit: number, maxBytes = READ_MAX_BYTES): string {
  const end = offset + limit - 1;
  const slice =
    `LC_ALL=C awk -v s=${offset} -v e=${end} -v max=${maxBytes} ` +
    `'NR < s { next } NR > e { exit } { n = length($0) + 1; if (used + n > max) { ` +
    `if (last == 0) { print substr($0, 1, max); last = NR; cut = 1 } exit } used += n; print; last = NR } ` +
    `END { print "MELINA-READ-END", last + 0, cut + 0 }' "$f"`;
  return [
    `f=${shQuote(path)}`,
    `if [ ! -e "$f" ]; then echo 'MELINA-READ missing'`,
    `elif [ -d "$f" ]; then echo 'MELINA-READ dir'; ls -lA "$f" 2>&1 | head -n 500`,
    `elif [ ! -r "$f" ]; then echo 'MELINA-READ unreadable'`,
    'else',
    `  b=$(wc -c < "$f" | tr -d ' ')`,
    `  z=$(head -c 8000 "$f" | tr -d -c '\\000' | wc -c | tr -d ' ')`,
    `  if [ "$z" -gt 0 ]; then echo "MELINA-READ binary $b"`,
    '  else',
    `    if [ "$b" -gt ${COUNT_LINES_MAX_BYTES} ]; then t=-1; else t=$(awk 'END { print NR }' "$f"); fi`,
    `    echo "MELINA-READ ok $t $b"`,
    `    ${slice}`,
    '  fi',
    'fi',
  ].join('\n');
}

/** read 的内容和脚本报的最后一行行号（0 是一行都没取到）、那一行是不是太长截过 */
export function readSlice(rest: string): { content: string; last: number; cut: boolean } {
  const at = rest.lastIndexOf('MELINA-READ-END ');
  if (at < 0) return { content: rest, last: -1, cut: false };
  const [last, cut] = rest
    .slice(at + 'MELINA-READ-END '.length)
    .trim()
    .split(/\s+/);
  return { content: rest.slice(0, at), last: Number(last ?? -1), cut: cut === '1' };
}

export async function runRead(env: ToolEnv, args: ReadArgs, signal: AbortSignal): Promise<ToolOutcome> {
  const checked = containerPath(args.path, { allowMelina: true, file: false });
  if (!checked.ok) return fail(checked.reason);
  const offset = args.offset ?? 1;
  const limit = args.limit ?? READ_DEFAULT_LINES;
  const shown = displayPath(checked.path);
  const recorded = { path: args.path, ...(args.offset ? { offset } : {}), ...(args.limit ? { limit } : {}) };
  return inContainer(env, 'read', readScript(checked.path, offset, limit), signal, recorded, (out, startedAt) => {
    const { status, rest, fields } = parse(out, 'MELINA-READ');
    const base = { id: env.deps.newId(), tool: 'read' as const, args: recorded, startedAt };
    switch (status) {
      case 'missing':
        return { ...base, raw: '', head: `${shown} 不存在`, error: '文件不存在' };
      case 'unreadable':
        return { ...base, raw: '', head: `${shown} 没有读权限`, error: '没有读权限' };
      case 'dir':
        return {
          ...base,
          raw: rest,
          head: `${shown} 是目录，下面是里面有什么（看文件内容要给文件路径）`,
          what: '列表',
        };
      case 'binary':
        return {
          ...base,
          raw: '',
          head: `${shown} 是二进制文件（${formatBytes(Number(fields[0] ?? 0))}），read 读不了；用 sh 看（file、xxd、strings）`,
          error: '二进制文件',
        };
      case 'ok': {
        const total = Number(fields[0] ?? -1);
        const bytes = Number(fields[1] ?? 0);
        const slice = readSlice(rest);
        // 脚本报的行号为准；没报（输出被截）时按取回的行数算
        const count =
          slice.last >= offset ? slice.last - offset + 1 : slice.last === 0 ? 0 : splitLines(slice.content).length;
        return {
          ...base,
          raw: slice.content,
          head: readHead(shown, { total, bytes, offset, count, cut: slice.cut }),
          render: (raw: string) => numbered(raw, offset),
          what: '这段内容',
        };
      }
      default:
        return { ...base, raw: out, head: `读 ${shown} 出错了`, error: '读文件出错' };
    }
  });
}

function readHead(
  shown: string,
  r: { total: number; bytes: number; offset: number; count: number; cut: boolean },
): string {
  if (r.total === 0 || r.bytes === 0) return `${shown}：空文件`;
  const size = r.total >= 0 ? `共 ${r.total} 行、${formatBytes(r.bytes)}` : `共 ${formatBytes(r.bytes)}`;
  if (r.count === 0) return `${shown}：${size}，第 ${r.offset} 行之后没有内容了`;
  const last = r.offset + r.count - 1;
  const cut = r.cut ? `；第 ${last} 行太长，只取了开头 ${formatBytes(READ_MAX_BYTES)}，整行用 sh 看` : '';
  const whole = r.offset === 1 && r.total >= 0 && last >= r.total;
  if (whole) return `${shown}：${size}${cut}`;
  let after = '';
  if (r.total >= 0 && last < r.total) after = `；后面还有 ${r.total - last} 行，用 offset=${last + 1} 接着读`;
  else if (r.total < 0) after = `；文件太大，没数一共多少行，要接着读用 offset=${last + 1}`;
  return `${shown}：${size}，这次是第 ${r.offset}–${last} 行${cut}${after}`;
}

/** 加行号，和 cat -n 一样：行号右对齐、tab 分隔。edit 的 old 不要带行号 */
export function numbered(raw: string, offset: number): string {
  return splitLines(raw)
    .map((line, i) => `${String(offset + i).padStart(6)}\t${line}`)
    .join('\n');
}

// ── edit ──────────────────────────────────────────────────────────────────

/**
 * 在容器里用 python3 替换。改完先写进同一个目录里的临时文件、带上原来的权限，再原子地换过去：写到一半失败（磁盘满）时原文件不动。
 * 符号链接改的是它指向的文件，链接本身不动。目录里建不了临时文件时（只读目录里的可写文件这类）退回原地写。
 */
export function editScript(path: string, oldText: string, newText: string, all: boolean): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const py = [
    'import base64, os, stat, sys, tempfile',
    'p = os.path.realpath(sys.argv[1])',
    `old = base64.b64decode('${b64(oldText)}').decode('utf-8')`,
    `new = base64.b64decode('${b64(newText)}').decode('utf-8')`,
    `replace_all = ${all ? 'True' : 'False'}`,
    'try:',
    "    with open(p, 'rb') as fh: data = fh.read()",
    'except FileNotFoundError:',
    "    print('MELINA-EDIT missing'); sys.exit(0)",
    'except IsADirectoryError:',
    "    print('MELINA-EDIT dir'); sys.exit(0)",
    'except PermissionError:',
    "    print('MELINA-EDIT unreadable'); sys.exit(0)",
    "if b'\\x00' in data[:8000]:",
    "    print('MELINA-EDIT binary'); sys.exit(0)",
    'try:',
    "    text = data.decode('utf-8')",
    'except UnicodeDecodeError:',
    "    print('MELINA-EDIT encoding'); sys.exit(0)",
    'count = text.count(old)',
    'if count == 0:',
    "    print('MELINA-EDIT notfound'); sys.exit(0)",
    'if count > 1 and not replace_all:',
    "    print('MELINA-EDIT multiple %d' % count); sys.exit(0)",
    'idx = text.find(old)',
    "line = text.count('\\n', 0, idx) + 1",
    'out = text.replace(old, new) if replace_all else text.replace(old, new, 1)',
    'try:',
    '    mode = stat.S_IMODE(os.stat(p).st_mode)',
    "    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix='.melina-edit-')",
    'except OSError:',
    '    fd = None',
    'if fd is None:',
    '    try:',
    "        with open(p, 'w', encoding='utf-8', newline='') as fh: fh.write(out)",
    '    except OSError as e:',
    "        print('MELINA-EDIT unwritable ' + (e.strerror or str(e))); sys.exit(0)",
    'else:',
    '    try:',
    "        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as fh: fh.write(out)",
    '        os.chmod(tmp, mode)',
    '        os.replace(tmp, p)',
    '    except OSError as e:',
    '        try: os.unlink(tmp)',
    '        except OSError: pass',
    "        print('MELINA-EDIT unwritable ' + (e.strerror or str(e))); sys.exit(0)",
    "lines = out.split('\\n')",
    "if lines and lines[-1] == '': lines.pop()",
    'start = max(0, line - 4)',
    "end = min(len(lines), line + new.count('\\n') + 3)",
    "print('MELINA-EDIT ok %d %d %d' % (count, line, len(lines)))",
    'for i in range(start, end):',
    "    print('%6d\\t%s' % (i + 1, lines[i]))",
  ].join('\n');
  return `python3 - ${shQuote(path)} <<'MELINA_EDIT_PY'\n${py}\nMELINA_EDIT_PY`;
}

export async function runEdit(env: ToolEnv, args: EditArgs, signal: AbortSignal): Promise<ToolOutcome> {
  const checked = containerPath(args.path, { allowMelina: false, file: true });
  if (!checked.ok) return fail(checked.reason);
  const inOld = placeholderIn(args.old);
  if (inOld) {
    return fail(
      `old 里有凭证占位符 ${inOld}：文件里那个位置其实是凭证的真值，你看到的只是占位符，old 匹配不上。old 别包含这一段，只改它旁边的部分`,
    );
  }
  const inNew = placeholderIn(args.new);
  if (inNew) return fail(placeholderWarning('new', inNew));
  const shown = displayPath(checked.path);
  const recorded = {
    path: args.path,
    old: preview(args.old),
    new: preview(args.new),
    ...(args.all ? { all: true } : {}),
  };
  const cmd = editScript(checked.path, args.old, args.new, args.all === true);
  return inContainer(env, 'edit', cmd, signal, recorded, (out, startedAt, result) => {
    const { status, rest, fields } = parse(out, 'MELINA-EDIT');
    const base = { id: env.deps.newId(), tool: 'edit' as const, args: recorded, startedAt };
    const failed = (head: string, error: string) => ({ ...base, raw: '', head, error });
    switch (status) {
      case 'ok': {
        const count = Number(fields[0] ?? 1);
        return {
          ...base,
          raw: rest,
          head: `已修改 ${shown}：替换了 ${count} 处，第一处在第 ${fields[1] ?? '?'} 行；改完共 ${fields[2] ?? '?'} 行。改动附近：`,
        };
      }
      case 'missing':
        return failed(`${shown} 不存在；新建文件用 write`, '文件不存在');
      case 'dir':
        return failed(`${shown} 是目录，不是文件`, '是目录');
      case 'unreadable':
        return failed(`${shown} 没有读权限`, '没有读权限');
      case 'binary':
      case 'encoding':
        return failed(`${shown} 不是 UTF-8 文本，edit 改不了；用 sh 或 write`, '不是 UTF-8 文本');
      case 'notfound':
        return failed(
          `没改：${shown} 里没有 old 这段文字。要逐字一样，包括空格、缩进和换行，也不能带 read 给的行号；先 read 看一下原文`,
          '没找到 old',
        );
      case 'multiple':
        return failed(
          `没改：old 在 ${shown} 里出现了 ${fields[0] ?? '多'} 次。多带几行上下文让它唯一，或者用 all=true 全部替换`,
          'old 不唯一',
        );
      case 'unwritable':
        return failed(`没改：${shown} 写不进去（${fields.join(' ') || '只读'}）`, '写不进去');
      default:
        if (result.exitCode === 127 || /python3: (command )?not found/.test(out)) {
          return failed('容器里没有 python3，edit 用不了；整个文件用 write 重写，或者用 sh 改', '没有 python3');
        }
        return { ...base, raw: out, head: `改 ${shown} 出错了`, error: '改文件出错' };
    }
  });
}

// ── write ─────────────────────────────────────────────────────────────────

/** 不用 exit：命令文件由登录 shell 执行，exit 会跑 ~/.bash_logout，它的输出会混进结果 */
export function writeScript(path: string, content: string): string {
  return [
    `p=${shQuote(path)}`,
    `if [ -e "$p" ]; then e=1; else e=0; fi`,
    `if [ -d "$p" ]; then echo 'MELINA-WRITE dir'`,
    `elif ! mkdir -p "$(dirname "$p")"; then echo 'MELINA-WRITE nodir'`,
    `elif base64 -d > "$p" <<'MELINA_WRITE_B64'`,
    base64Lines(content),
    'MELINA_WRITE_B64',
    `then echo "MELINA-WRITE ok $e"`,
    `else echo 'MELINA-WRITE unwritable'`,
    'fi',
  ].join('\n');
}

export async function runWrite(env: ToolEnv, args: WriteArgs, signal: AbortSignal): Promise<ToolOutcome> {
  const checked = containerPath(args.path, { allowMelina: false, file: true });
  if (!checked.ok) return fail(checked.reason);
  const inContent = placeholderIn(args.content);
  if (inContent) return fail(placeholderWarning('content', inContent));
  const shown = displayPath(checked.path);
  const recorded = { path: args.path, content: preview(args.content) };
  const cmd = writeScript(checked.path, args.content);
  return inContainer(env, 'write', cmd, signal, recorded, (out, startedAt) => {
    const { status, fields } = parse(out, 'MELINA-WRITE');
    const base = { id: env.deps.newId(), tool: 'write' as const, args: recorded, startedAt };
    if (status === 'ok') {
      const lines = splitLines(args.content).length;
      const verb = fields[0] === '1' ? '覆盖了' : '新建了';
      return {
        ...base,
        raw: args.content,
        head: `${verb} ${shown}：${lines} 行，${formatBytes(Buffer.byteLength(args.content))}`,
        echo: false,
      };
    }
    const why =
      status === 'dir'
        ? `${shown} 是目录`
        : status === 'nodir'
          ? `建不了 ${shown} 所在的目录`
          : status === 'unwritable'
            ? `${shown} 写不进去（只读或没有权限）`
            : `写 ${shown} 出错了`;
    return { ...base, raw: status ? '' : out, head: `没写：${why}`, error: why };
  });
}

// ── 凭证占位符 ────────────────────────────────────────────────────────────

/**
 * 输出里的凭证值都换成了占位符。
 * 模型读到的文件里也是占位符：原样写回去会把文件里的真值换掉，拿它当 old 又永远匹配不上。所以带占位符的 write、edit 不执行，说清楚怎么办
 * （和提示词里教的用法一个说法：从原处读，设置里配的在环境变量里，附件、工作目录文件里的从那个文件取）。
 * 不把占位符换回真值：同一个占位符可能来自原值，也可能来自 base64、URL 编码的变形，换回去不一定对。
 */
const PLACEHOLDER = /\[凭证(?:「[^」\n]{1,200}」)?已隐藏\]/;

function placeholderIn(text: string): string | undefined {
  return PLACEHOLDER.exec(text)?.[0];
}

function placeholderWarning(field: 'content' | 'new', found: string): string {
  return `${field} 里有凭证占位符 ${found}：它代表一个你看不到原文的凭证值，原样写进文件会把真值换成这串字。要改的文件里有凭证，就用 edit 只改别的部分；要把凭证写进文件，用 sh 从它原来的地方读：设置里配的在环境变量里，比如 printf '%s' "$变量名" >> 文件；附件、工作目录文件里的从那个文件取，比如 sed -n 's/^API_TOKEN=//p' .env >> 文件`;
}

// ── 共用 ──────────────────────────────────────────────────────────────────

type Built = Omit<Parameters<typeof observe>[1], 'startedAt'> & { startedAt: number };

/** 在调用方的容器里执行一段脚本，按输出拼成 Observation；没跑起来、超时、被取消也记一条 */
async function inContainer(
  env: ToolEnv,
  tool: 'read' | 'edit' | 'write',
  cmd: string,
  signal: AbortSignal,
  recorded: Record<string, unknown>,
  build: (output: string, startedAt: number, result: ContainerExecResult) => Built,
): Promise<ToolOutcome> {
  const { deps, caller } = env;
  if (!caller.container) return fail(`这次调用没有容器，${tool} 用不了`);
  const container = caller.container;
  await env.ready;
  if (signal.aborted) return fail('已取消，没有执行');
  let slot: Awaited<ReturnType<typeof toolSlot>>;
  try {
    slot = await toolSlot(env, signal);
  } catch (error) {
    return fail(`没有执行：${messageOf(error)}`);
  }
  if (!slot) return fail('已取消，没有执行');
  const startedAt = Date.now();
  const collector = tool === 'read' ? outputInspector(env) : undefined;
  let result: ContainerExecResult;
  try {
    result = await deps.runtime.exec(container, {
      cmd,
      timeoutMs: deps.fileTimeoutMs,
      signal,
      ...(collector
        ? {
            inspectPrivate: (output: string) => {
              const { status, rest } = parse(output, 'MELINA-READ');
              const slice = readSlice(rest);
              if (status !== 'ok' || slice.cut || slice.last < 0) return output;
              const at = output.indexOf(rest);
              return output.slice(0, at) + collector.inspect(slice.content) + rest.slice(slice.content.length);
            },
          }
        : {}),
    });
  } catch (error) {
    slot.release();
    return observe(env, {
      id: deps.newId(),
      tool,
      args: recorded,
      raw: '',
      head: `没执行：${messageOf(error)}`,
      error: messageOf(error),
      startedAt,
    });
  }
  slot.release();
  if (result.timedOut || result.cancelled) {
    const why = result.timedOut ? `超时（${Math.round(deps.fileTimeoutMs / 1000)} 秒）` : '被取消';
    return observe(env, {
      id: deps.newId(),
      tool,
      args: recorded,
      raw: '',
      head: `没做完：${why}`,
      error: why,
      startedAt,
    });
  }
  const outcome = await observe(env, build(result.output, startedAt, result));
  return collector ? collector.finish(outcome) : outcome;
}

/** 脚本输出的第一行是 `<标记> <状态> <字段…>`，后面是内容 */
function parse(output: string, marker: string): { status: string | undefined; fields: string[]; rest: string } {
  const at = output.indexOf(`${marker} `);
  if (at < 0) return { status: undefined, fields: [], rest: output };
  const lineEnd = output.indexOf('\n', at);
  const header = output.slice(at + marker.length + 1, lineEnd < 0 ? undefined : lineEnd).trim();
  const [status, ...fields] = header.split(/\s+/);
  return { status, fields, rest: lineEnd < 0 ? '' : output.slice(lineEnd + 1) };
}
