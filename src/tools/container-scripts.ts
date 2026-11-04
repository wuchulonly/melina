// 在容器里跑的几段 POSIX sh（tools/container.ts 用 `<引擎> exec -i <容器> sh -c <脚本> <名字> <参数…>` 执行）。
// 参数都按位置传，命令原文从 stdin 读、写进文件再交给 bash，不拼进脚本，不会被二次解释。脚本只用 sh、setsid、sed、cut、tr、grep、kill，
// dash（Ubuntu 的 /bin/sh）和 busybox 都有；单元测试直接在宿主机上跑它们。
//
// 容器里的几个位置：
// - 状态目录（默认 /run/melina，每次启动容器时新挂的 tmpfs，停掉就清空）：exec/<id> 记前台命令的进程组，exec/<id>.sh 是命令文件，
//   exec/<id>.cancel 是取消标记，bg/<pid>.rec 记后台进程。
// - 日志目录（默认 /melina/logs，在容器自己的文件系统里）：后台进程的输出 bg-<pid>.log。

// 下面都是普通的模板字符串：\${ 写出 sh 的 ${，\\n 写出 printf 里的 \n。

/** 共用的两个函数：pid 会被复用，所以后台进程的记录里存着启动时间，对得上、又不是僵尸，才算还活着 */
const PRELUDE = `
starttime() {
  sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20
}
alive() {
  st=$(sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1,20)
  [ -n "$st" ] || return 1
  [ "\${st%% *}" != Z ] || return 1
  [ "\${st#* }" = "$2" ]
}
`;

/**
 * 命令所在 cgroup 的三个计数：pids.events 的 max（进程数撞到上限、起进程失败的次数）、
 * memory.events 的 oom_kill、cpu.pressure 里 some 的 total（有进程在等 CPU 的微秒数），读不到的写 -。
 * 只用内建命令（read、case、[）：进程数撞满时 fork 不出 cat，正是要记下这种时候。cgroup 的位置按 /proc/self/cgroup 的 0:: 那行找，
 * 容器有自己的 cgroup namespace 时那行是 0::/，读到的就是这个容器自己的计数。$cgroot 是 cgroup 挂在哪（默认 /sys/fs/cgroup）
 */
const COUNTS = `
counts() {
  _pm=- _oom=- _cpu=- _cg=
  if [ -r /proc/self/cgroup ]; then
    while IFS= read -r _l; do
      case $_l in 0::*) _cg=\${_l#0::} ;; esac
    done </proc/self/cgroup
  fi
  _d=$cgroot\${_cg%/}
  if [ -r "$_d/pids.events" ]; then
    while read -r _k _v; do [ "$_k" = max ] && _pm=$_v; done <"$_d/pids.events"
  fi
  if [ -r "$_d/memory.events" ]; then
    while read -r _k _v; do [ "$_k" = oom_kill ] && _oom=$_v; done <"$_d/memory.events"
  fi
  if [ -r "$_d/cpu.pressure" ]; then
    while read -r _k _a _b _c _t; do [ "$_k" = some ] && _cpu=\${_t#total=}; done <"$_d/cpu.pressure"
  fi
  return 0
}
`;

/**
 * 前台命令。参数：$1 本次的随机 id，$2 状态目录，$3 工作目录，$4 cgroup 挂在哪（可选，测试用）；命令原文从 stdin 读
 * （单个参数最长 128 KiB，长命令放不进参数）。
 * 命令写进 exec/<id>.sh，在新会话的登录 bash 中开启 pipefail，避免尾部过滤器掩盖前面的失败；
 * 进程组 id 就是它的 pid，记在 exec/<id>，取消时整组杀掉；
 * 环境变量 MELINA_EXEC=<id> 传给所有子孙，自己 setsid 出去的也能按它找到。
 * 取消可能落在命令起来之前（引擎起 exec 要几百毫秒）：杀进程的脚本先留下 exec/<id>.cancel，这里起命令前、记下 pid 后各看一眼。
 * stderr 并进 stdout（按到达顺序），stdin 是 /dev/null。命令结束后打结束标记「\nMELINA-EXIT-<id> <退出码> <三个计数的增量>\n」
 * （增量按 COUNTS 的顺序，读不到的是 -；命令没起来时只有退出码），自己也以那个退出码退出。
 * 杀进程的脚本不杀这个包装脚本：超时、取消时它照样等命令被杀、读完计数、打出结束标记
 */
export const EXEC_SCRIPT = `${PRELUDE}${COUNTS}
id=$1
d=$2/exec
cgroot=\${4:-/sys/fs/cgroup}
mkdir -p "$d" 2>/dev/null
f=$d/$id.sh
cat >"$f"
if [ -e "$d/$id.cancel" ]; then
  rm -f "$f" "$d/$id.cancel"
  printf '\\nMELINA-EXIT-%s %s\\n' "$id" 137
  exit 137
fi
if ! cd "$3" 2>/dev/null; then
  rm -f "$f"
  printf '工作目录不存在：%s\\n' "$3"
  printf '\\nMELINA-EXIT-%s %s\\n' "$id" 2
  exit 2
fi
counts
pm0=$_pm oom0=$_oom cpu0=$_cpu
MELINA_EXEC=$id
export MELINA_EXEC
setsid bash -l -o pipefail "$f" </dev/null 2>&1 &
pid=$!
echo "$pid" >"$d/$id"
if [ -e "$d/$id.cancel" ]; then
  kill -s KILL "$pid" 2>/dev/null
  kill -s KILL -- "-$pid" 2>/dev/null
fi
wait "$pid" 2>/dev/null
rc=$?
counts
dpm=- doom=- dcpu=-
case "$pm0$_pm" in *[!0-9]* | '') ;; *) dpm=$((_pm - pm0)) ;; esac
case "$oom0$_oom" in *[!0-9]* | '') ;; *) doom=$((_oom - oom0)) ;; esac
case "$cpu0$_cpu" in *[!0-9]* | '') ;; *) dcpu=$((_cpu - cpu0)) ;; esac
rm -f "$f" "$d/$id" "$d/$id.cancel"
printf '\\nMELINA-EXIT-%s %s %s %s %s\\n' "$id" "$rc" "$dpm" "$doom" "$dcpu"
exit "$rc"
`;

/**
 * 取消或超时：杀掉一次前台命令留下的所有进程。参数：$1 那次的 id，$2 状态目录。
 * 先留下取消标记（命令还没起来的话就不会再起），再杀进程本身和它的进程组（刚 fork 还没 setsid 时进程组还不存在），
 * 最后按环境变量里的 MELINA_EXEC 扫一遍 /proc，连 setsid 出去的子孙一起杀。包装脚本自己不带这个变量，
 * 它会等到命令被杀、打出结束标记再退出。只用内建命令读 pid（进程数满了时 fork 不出 cat）；
 * GNU grep 一次扫完所有进程，不支持 -z 的 grep（busybox）就一个个看。
 */
export const KILL_SCRIPT = `
id=$1
d=$2/exec
mkdir -p "$d" 2>/dev/null
: >"$d/$id.cancel"
if [ -r "$d/$id" ]; then
  read -r pg <"$d/$id"
  if [ -n "$pg" ]; then
    kill -s KILL "$pg" 2>/dev/null
    kill -s KILL -- "-$pg" 2>/dev/null
  fi
fi
if printf 'a\\0' | grep -qz a 2>/dev/null; then
  for e in $(grep -lzxF "MELINA_EXEC=$id" /proc/[0-9]*/environ 2>/dev/null); do
    p=\${e#/proc/}
    kill -s KILL "\${p%/environ}" 2>/dev/null
  done
else
  for e in /proc/[0-9]*/environ; do
    if { tr '\\0' '\\n' <"$e"; } 2>/dev/null | grep -qxF "MELINA_EXEC=$id"; then
      p=\${e#/proc/}
      kill -s KILL "\${p%/environ}" 2>/dev/null
    fi
  done
fi
exit 0
`;

/**
 * 后台命令。参数：$1 本次的随机 id，$2 状态目录，$3 日志目录，$4 工作目录，$5 最多几个，$6 给人看的一行命令；命令原文从 stdin 读。
 * 先数还活着的后台进程，满了打「MELINA-BG-FULL <个数>」；工作目录不在打「MELINA-BG-NODIR」；
 * 否则在新会话里起命令，输出写进 <日志目录>/bg-<pid>.log，打「MELINA-BG <pid> <日志>」后立即返回，进程跨调用存活。
 * 记录 bg/<pid>.rec 四行：启动时间、日志、给人看的命令、命令文件。
 */
export const BG_SCRIPT = `${PRELUDE}
id=$1
d=$2/bg
logs=$3
mkdir -p "$d" "$logs" 2>/dev/null
f=$d/$id.sh
cat >"$f"
n=0
for r in "$d"/*.rec; do
  [ -e "$r" ] || continue
  pid=\${r##*/}
  pid=\${pid%.rec}
  if alive "$pid" "$(sed -n 1p "$r")"; then n=$((n + 1)); else rm -f "$r" "$(sed -n 4p "$r")" 2>/dev/null; fi
done
if [ "$n" -ge "$5" ]; then
  rm -f "$f"
  printf 'MELINA-BG-FULL %s\\n' "$n"
  exit 0
fi
if ! cd "$4" 2>/dev/null; then
  rm -f "$f"
  printf 'MELINA-BG-NODIR\\n'
  exit 0
fi
tmp=$logs/.bg-$id.log
setsid bash -l -o pipefail "$f" </dev/null >"$tmp" 2>&1 &
pid=$!
log=$logs/bg-$pid.log
mv -f "$tmp" "$log"
printf '%s\\n%s\\n%s\\n%s\\n' "$(starttime "$pid")" "$log" "$6" "$f" >"$d/$pid.rec"
printf 'MELINA-BG %s %s\\n' "$pid" "$log"
`;

/** 把 stdin 写进容器里的一个文件（文件形式的凭证），只有 root 能读。参数：$1 容器里的绝对路径 */
export const WRITE_FILE_SCRIPT = `
umask 077
mkdir -p "$(dirname "$1")" && cat >"$1"
`;

export interface ParsedBackground {
  kind: 'started' | 'full' | 'nodir';
  pid?: number;
  log?: string;
  count?: number;
}

/** 解析 BG_SCRIPT 的输出 */
export function parseBackgroundOutput(stdout: string): ParsedBackground | undefined {
  for (const line of stdout.split('\n')) {
    const started = /^MELINA-BG (\d+) (.+)$/.exec(line);
    if (started) return { kind: 'started', pid: Number(started[1]), log: started[2] };
    const full = /^MELINA-BG-FULL (\d+)$/.exec(line);
    if (full) return { kind: 'full', count: Number(full[1]) };
    if (line === 'MELINA-BG-NODIR') return { kind: 'nodir' };
  }
  return undefined;
}

/** 后台进程记录里存的那一行命令：只取第一行、去掉制表符、最长 200 个字符 */
export function displayCommand(cmd: string): string {
  const lines = cmd.trim().split('\n');
  let first = (lines[0] ?? '').replace(/\t/g, ' ').trim();
  if (first.length > 200) first = `${first.slice(0, 199)}…`;
  return lines.length > 1 ? `${first} …` : first;
}
