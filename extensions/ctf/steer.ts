// CTF 命令拦截：扫描与后置爆破规则。
// 分类规则改自 QiantangCredit/heimdall-agent d9368848，MIT 许可见 steer.LICENSE。
// Melina 用当前路线的 WatchNote 代替 steer.json；命令文本的启发式分类不解释任意脚本语言。

import { watchEnabled } from '../../src/core/config.ts';
import { type ShArgs, TOOL } from '../../src/core/tools.ts';
import type { WatchBody } from '../../src/core/types.ts';
import { bruteLaterScore, compareWatchAngles } from '../../src/core/watch-map.ts';
import { bet0WatchEnabled } from '../../src/projections/bet0.ts';
import { latestWatch } from '../../src/projections/watch.ts';
import { currentRun, type ToolEnv } from '../../src/tools/session.ts';

export const LIGHT_PATHS = 200;
const LIGHT_PORTS = 24;
const PORT_RANGE_BLOCK = 80;
const PORT_SCAN_TOOLS = new Set(['nmap', 'masscan']);
const PATH_REQUEST_TOOLS = new Set(['curl', 'wget']);
const FORBID_TOOLS = new Set(['ffuf', 'gobuster', 'feroxbuster', 'dirb', 'dirbuster', 'wfuzz', 'nikto']);
const LATER_TOOLS = new Set(['hashcat', 'john', 'hydra', 'medusa', 'patator', 'jwt_tool', 'jwt-cracker']);
// 只开放单模板验证需要的参数；未知参数默认拒绝，防止配置、工作流和其他选择器扩大范围。
const NUCLEI_SWITCHES = new Set([
  'duc',
  'disable-update-check',
  'ni',
  'no-interactsh',
  'silent',
  'nc',
  'no-color',
  'j',
  'jsonl',
  'debug',
  'debug-req',
  'debug-resp',
  'irr',
  'include-rr',
  'fr',
  'follow-redirects',
  'fhr',
  'follow-host-redirects',
  'v',
  'verbose',
]);
const NUCLEI_VALUES = new Set([
  'u',
  'target',
  'o',
  'output',
  'H',
  'header',
  'V',
  'var',
  'timeout',
  'retries',
  'mr',
  'max-redirects',
  'rl',
  'rate-limit',
  'c',
  'concurrency',
  'bs',
  'bulk-size',
  'p',
  'proxy',
]);

const WORDLIST_RE =
  /rockyou|sqlmap\/.*\/wordlist|wordlists\/|top-20k|1\.6m|flask-unsign|jwt-cracker|hashcat|hydra|john\b|secret.?brute|password.?spray/i;
const WL_INSPECT_RE = /\b(?:ls|cat|head|tail|wc|file|less|more|nl|find)\b/i;
const WL_CAMPAIGN_RE = /\b(?:for|while|dirsearch|ffuf|gobuster|hydra|hashcat|sqlmap|feroxbuster|dirb|wfuzz)\b/i;
const TARGETED_WL_RE = /wordlists\/(?:sqli(?:_login)?|lfi)\.txt|spray_(?:users|passwords|creds)\.txt|loot\.json/i;
const BRUTE_WL_RE = /wordlists\/(?:jwt|passwords|usernames|creds)\.txt/i;
const HEAVY_SCAN_RE = /rockyou|seclists|dicc\.txt|top-20k|1\.6m|\b9k\b/i;
const DIRSEARCH_W_RE = /(?:^|\s)(?:-w|--wordlist)(?:\s+|=)(\S+)/i;
const DIRSEARCH_INFO_RE = /^\s*(?:[^\s;|&]+\/)?dirsearch\s+(?:-h|--help|--version)\s*$/;
const PATH_TOKEN_RE = /(?:^|[\s'"=])(\/[A-Za-z0-9._~/-]{1,80})/g;
const SKILL_READ_RE = /\/(?:opt\/(?:heimdall|ctf)|melina\/ctf)|grep\s|find\s|SECRET_KEY|secret_key|app\.py|CLAUDE\.md/i;

type BlockKind = 'forbid' | 'later';
interface Invocation {
  name: string;
  args: string[];
}

/** 原版的两档分类；Melina 的扫描器经 sh 启动，工具名拦截也在这里一起判。 */
export function classifyCommand(text: string): BlockKind | null {
  const cmd = String(text || '');
  if (!cmd.trim()) return null;
  if (DIRSEARCH_INFO_RE.test(cmd)) return null;
  const commands = invokedCommands(cmd);
  const tools = commands.map((command) => command.name);
  if (tools.some((tool) => FORBID_TOOLS.has(tool))) return 'forbid';
  if (commands.some((command) => command.name === 'nuclei' && !isSingleTemplateScan(command))) return 'forbid';
  if (commands.some(isWidePortScan)) return 'forbid';
  if (tools.includes('dirsearch') && !isLightPathsScan(cmd)) return 'forbid';
  if (HEAVY_SCAN_RE.test(cmd) && tools.includes('dirsearch')) return 'forbid';
  if (
    hasPathRequest(commands) &&
    [...cmd.matchAll(PATH_TOKEN_RE)].length > LIGHT_PATHS &&
    /\bfor\b|\bwhile\b/.test(cmd)
  )
    return 'forbid';
  if (tools.some((tool) => LATER_TOOLS.has(tool))) return 'later';
  if (isLightPathsScan(cmd)) return null;
  return isWordlistCampaign(cmd) ? 'later' : null;
}

/** 只识别显式本地 YAML 路径，不展开变量、glob、URL、列表或模板目录。 */
function isSingleTemplateScan({ args }: Invocation): boolean {
  let templates = 0;
  for (let i = 0; i < args.length; i++) {
    const redirected = consumeSafeRedirect(args, i);
    if (redirected !== null) {
      i = redirected;
      continue;
    }
    const option = /^--?([A-Za-z][A-Za-z-]*)(?:=(.*))?$/.exec(args[i] ?? '');
    if (!option) return false;
    const name = option[1] ?? '';
    if (NUCLEI_SWITCHES.has(name)) {
      if (option[2] !== undefined && !/^(true|false)$/.test(option[2])) return false;
      continue;
    }
    if (name !== 't' && name !== 'templates' && !NUCLEI_VALUES.has(name)) return false;
    const value = option[2] ?? args[++i];
    if (!value || value.startsWith('-')) return false;
    if (name === 't' || name === 'templates') {
      templates++;
      if (templates > 1 || !/^\/?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ya?ml$/.test(value)) return false;
    }
  }
  return templates === 1;
}

/** 允许附加输出重定向或关闭输入（2>&1、2>/dev/null、> out.txt、</dev/null），拒绝从文件重定向输入。 */
function consumeSafeRedirect(args: readonly string[], index: number): number | null {
  const arg = args[index] ?? '';
  if (/^(?:\d*>&(?:\d+|-)|\d*<&-|0?<\/dev\/null|(?:&>>?|\d*>>?)(?!-)\S+)$/.test(arg)) return index;
  if (/^(?:&>>?|\d*>>?)$/.test(arg)) {
    const target = args[index + 1];
    return target && !target.startsWith('-') && !/^[<>]/.test(target) ? index + 1 : null;
  }
  if (/^0?<$/.test(arg) && args[index + 1] === '/dev/null') return index + 1;
  return null;
}

/** 只检查扫描器明确传入的端口范围；通用循环的数值不能证明它在发网络请求。 */
function isWidePortScan(command: Invocation): boolean {
  if (!PORT_SCAN_TOOLS.has(command.name)) return false;
  for (let i = 0; i < command.args.length; i++) {
    const arg = command.args[i] ?? '';
    const ports = arg === '-p' || arg === '--ports' ? command.args[++i] : /^(?:-p|--ports=)(.+)$/.exec(arg)?.[1];
    if (ports === '-') return true;
    for (const part of ports?.split(',') ?? []) {
      const range = /^(?:[TUS]:)?(\d+)-(\d+)$/.exec(part);
      if (range && Number(range[2]) - Number(range[1]) >= PORT_RANGE_BLOCK) return true;
    }
  }
  return false;
}

function hasPathRequest(commands: Invocation[]): boolean {
  return commands.some(
    ({ name, args }) =>
      PATH_REQUEST_TOOLS.has(name) && !args.every((arg) => ['-h', '--help', '-V', '--version'].includes(arg)),
  );
}

function isWordlistInspect(cmd: string): boolean {
  if (WL_CAMPAIGN_RE.test(cmd) || /rockyou|sqlmap\/.*\/wordlist|top-20k|1\.6m/i.test(cmd)) return false;
  return /wordlists\//i.test(cmd) && WL_INSPECT_RE.test(cmd);
}

function isLightPathsScan(cmd: string): boolean {
  if (invokedTools(cmd).includes('dirsearch')) {
    if (HEAVY_SCAN_RE.test(cmd)) return false;
    const match = DIRSEARCH_W_RE.exec(cmd);
    // 原版的 dirsearch 包装器默认用 paths.txt；Melina 的 Kali 默认是大词表，必须显式选择小表。
    return match !== null && /wordlists\/paths\.txt(?:['"])?$/.test((match[1] ?? '').replace(/\\/g, '/'));
  }
  return (
    /wordlists\/paths\.txt/i.test(cmd) &&
    !HEAVY_SCAN_RE.test(cmd) &&
    !invokedTools(cmd).some((t) => FORBID_TOOLS.has(t))
  );
}

function isWordlistCampaign(cmd: string): boolean {
  if (SKILL_READ_RE.test(cmd) && !WORDLIST_RE.test(cmd)) return false;
  if (!WORDLIST_RE.test(cmd) || isWordlistInspect(cmd) || isLightPathsScan(cmd)) return false;
  if (TARGETED_WL_RE.test(cmd) && !BRUTE_WL_RE.test(cmd)) return false;
  if (/flask-unsign/i.test(cmd) && !/wordlist|crack|sqlmap|rockyou|top-20|1\.6/i.test(cmd)) {
    if ((cmd.match(/['"][^'"]{0,80}['"]/g) || []).length <= LIGHT_PORTS) return false;
  }
  return true;
}

function invokedTools(cmd: string): string[] {
  return invokedCommands(cmd).map((command) => command.name);
}

/** 只取命令位置及其参数，读文档、查询安装路径不算启动扫描器；兼顾常用包装和 bash -c。 */
function invokedCommands(cmd: string, depth = 0): Invocation[] {
  if (depth > 4) return [];
  const tokens =
    cmd.match(
      /"(?:\\.|[^"\\])*"|'[^']*'|\d*>&(?:\d+|-)|\d*<&(?:\d+|-)|&>>?(?:\\.|[^\s"';&|()<>])*|\d*>>?(?:\\.|[^\s"';&|()<>])*|\d*<<<?(?:\\.|[^\s"';&|()<>])*|(?:\\.|[^\s"';&|()])+|[;&|\n()]/g,
    ) ?? [];
  const found: Invocation[] = [];
  let command = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (/^[;&|\n()]$/.test(token)) {
      command = true;
      continue;
    }
    if (!command) continue;
    const word = token.replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (/^[A-Za-z_]\w*=/.test(word) || /^-/.test(word)) continue;
    if (/^(?:\d*>&(?:\d+|-)|\d*<&(?:\d+|-)|&>>?.+|\d*>>?.+|\d*<<<?.+)$/.test(word)) continue;
    if (/^(?:&>>?|\d*>>?|\d*<<<?)$/.test(word)) {
      if (tokens[i + 1] && !/^[;&|\n()]$/.test(tokens[i + 1] ?? '')) i++;
      continue;
    }
    if (word === 'command' && /^-[^-]*[vV]/.test(tokens[i + 1] ?? '')) {
      command = false;
      continue;
    }
    if (['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time'].includes(word)) continue;
    if (['exec', 'env', 'command', 'nohup'].includes(word)) continue;
    if (word === 'sudo') {
      if (tokens[i + 1] === '-u' || tokens[i + 1] === '-g') i += 2;
      continue;
    }
    if (word === 'timeout') {
      while (tokens[i + 1]?.startsWith('-')) i++;
      i++;
      continue;
    }
    command = false;
    let name = commandName(word);
    // Kali 的 dirsearch 和一些凭据工具也常直接通过 Python 脚本或模块启动。
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j] ?? '';
        if (arg === '-c' || /^[;&|\n()]$/.test(arg)) break;
        if (arg === '-m') {
          name = commandName(tokens[j + 1] ?? '');
          break;
        }
        if (arg.startsWith('-')) continue;
        name = commandName(arg);
        break;
      }
    }
    const args: string[] = [];
    for (let j = i + 1; j < tokens.length && !/^[;&|\n()]$/.test(tokens[j] ?? ''); j++)
      args.push((tokens[j] ?? '').replace(/^(['"])([\s\S]*)\1$/, '$2'));
    found.push({ name, args });
    if (name !== 'bash' && name !== 'sh') continue;
    for (let j = i + 1; j < tokens.length && !/^[;&|\n()]$/.test(tokens[j] ?? ''); j++) {
      if (/^-[^-]*c/.test(tokens[j] ?? '')) {
        const script = tokens[j + 1]?.replace(/^(['"])([\s\S]*)\1$/, '$2');
        if (script) found.push(...invokedCommands(script, depth + 1));
        break;
      }
    }
  }
  return found;
}

function commandName(token: string): string {
  return (
    token
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
      .split('/')
      .at(-1)
      ?.toLowerCase()
      .replace(/\.py$/, '') ?? ''
  );
}

/** 后置操作不把自身算成「别的方向还没试」；未交过地图时保持关闭。 */
export function commandSteer(note: WatchBody | undefined): { now: string[]; laterOpen: boolean } {
  const now = (note?.directions ?? [])
    .filter(
      (item) => !item.retired && item.status === 'untried' && !bruteLaterScore(`${item.direction} ${item.result}`),
    )
    .sort(compareWatchAngles)
    .map((item) => item.direction);
  return { now, laterOpen: note !== undefined && now.length === 0 };
}

function isRepeatDirscan(cmd: string): boolean {
  if (DIRSEARCH_INFO_RE.test(cmd)) return false;
  if (invokedTools(cmd).includes('dirsearch')) return true;
  if (isWordlistInspect(cmd)) return false;
  // 读取或遍历本地路径不是探查；手动枚举须有实际请求调用才检查禁扫标记。
  return (
    hasPathRequest(invokedCommands(cmd)) &&
    /\bfor\b|\bwhile\b/.test(cmd) &&
    (isLightPathsScan(cmd) || [...cmd.matchAll(PATH_TOKEN_RE)].length > 48)
  );
}

/** 网关检查与执行入口共用；当前领域和地图每次现读，显式 MELINA_ALLOW_FUZZ=1 时放行。 */
export function commandBlockReason(env: ToolEnv, tool: string, args: unknown): string | undefined {
  if (
    tool !== TOOL.sh &&
    tool !== 'dirsearch' &&
    tool !== 'nuclei' &&
    !FORBID_TOOLS.has(tool) &&
    !LATER_TOOLS.has(tool)
  )
    return undefined;
  // 环境工具也供没有 RunStore 的单 agent 基线复用；地图策略只在完整网关环境生效。
  if (typeof env.deps.queries.getRun !== 'function') return undefined;
  const run = currentRun(env);
  if (process.env.MELINA_ALLOW_FUZZ?.trim() === '1' || run.goal.domain !== 'ctf') return undefined;
  const body = tool === TOOL.sh && args && typeof args === 'object' ? (args as Partial<ShArgs>).cmd : undefined;
  let kind: BlockKind | null;
  if (tool === TOOL.sh) kind = typeof body === 'string' ? classifyCommand(body) : null;
  // 命名扩展没有统一的 argv 契约，不能证明只执行一个模板；走 sh 的显式命令才可放行。
  else kind = FORBID_TOOLS.has(tool) || tool === 'nuclei' ? 'forbid' : LATER_TOOLS.has(tool) ? 'later' : null;
  const dirscan = !kind && (tool === 'dirsearch' || (typeof body === 'string' && isRepeatDirscan(body)));
  if (!kind && !dirscan) return undefined;
  // 主动关闭观察的路线没有地图可等；后置等待不适用，重型扫描禁令仍然生效。
  if (
    kind === 'later' &&
    !(env.branch ? bet0WatchEnabled(env.deps.queries, run, env.branch.betId) : watchEnabled(run.config))
  )
    return undefined;
  // 每条求解路线只使用自己的地图，同模型副本也不能借用另一条路线的放行状态。
  const note = env.caller.branchId ? latestWatch(env.deps.queries, env.run.id, env.caller.branchId) : undefined;
  // 原版 dirbustAlreadyForbidden：只看当前地图，不根据历史扫描次数永久封住路线。
  const dirscanForbidden = dirscan && (note?.forbid ?? []).some((item) => item.toLowerCase().includes('dirbust'));
  if (dirscanForbidden) kind = 'forbid';
  if (!kind) return undefined;
  const steer = commandSteer(note);
  if (kind === 'later' && steer.laterOpen) return undefined;
  const lines = [
    dirscanForbidden
      ? '命令没有执行：观察者当前地图的 forbid 含 dirbust，暂缓重复目录探查；标记撤销后可恢复。'
      : kind === 'forbid'
        ? '命令没有执行：CTF 策略禁止大范围扫描或重型扫描器。'
        : '命令没有执行：字典或密钥爆破暂缓，先尝试观察地图上其他还没试的方向。',
    '轻量 dirsearch 探查须显式用 -w wordlists/paths.txt 指定自选的小词表；是否暂缓由观察者当前地图的 dirbust 标记决定。定向的小字典探查可以。',
    'nuclei 须通过 sh 用 -t 显式指定单个本地 .yaml/.yml 模板；禁止标签、目录、URL、工作流、配置文件和其他模板选择器。',
  ];
  if (steer.now.length) lines.push('当前还可以尝试：', ...steer.now.slice(0, 4).map((angle) => `- ${angle}`));
  else if (!note) lines.push('旁观者还没有交地图，先做少量定向探查。');
  return lines.join('\n');
}
