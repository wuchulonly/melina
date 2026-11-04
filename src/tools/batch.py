"""sh 内的 melina-batch：有总预算的批量执行、逐项落盘和有界等待。"""

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('must be finite and positive')
    return number


def nonnegative(value):
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError('must be finite and nonnegative')
    return number


def save(directory, state):
    # 先落临时文件再替换，读者只会看到完整一版；派发前先记 running。
    path = directory / 'state.json'
    temp = directory / 'state.tmp'
    with temp.open('w', encoding='utf-8') as output:
        json.dump(state, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)


def read(directory):
    with (directory / 'state.json').open(encoding='utf-8') as source:
        return json.load(source)


def snapshot(directory):
    # 空闲时持共享锁读状态，避免新 runner 在读锁与读状态之间启动。
    try:
        lock = (directory / 'runner.lock').open('r')
    except FileNotFoundError:
        return {'status': 'not_started', 'active': False, 'counts': {}}
    with lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            active = False
        except BlockingIOError:
            active = True
        try:
            state = read(directory)
        except FileNotFoundError:
            return {'status': 'starting' if active else 'not_started', 'active': active, 'counts': {}}
    if not active:
        for item in state['items']:
            if item['status'] == 'running':
                item['status'] = 'unknown'
        if state['status'] == 'running':
            state['status'] = 'interrupted'
    state['active'] = active
    counts = {}
    for item in state['items']:
        counts[item['status']] = counts.get(item['status'], 0) + 1
    state['counts'] = counts
    return state


def emit(state):
    print(json.dumps(state, ensure_ascii=False), flush=True)


def remaining():
    value = os.environ.get('MELINA_SH_DEADLINE_MS')
    if not value:
        return None
    deadline = float(value)
    if not math.isfinite(deadline):
        raise ValueError('MELINA_SH_DEADLINE_MS must be finite')
    return max(0.0, deadline / 1000 - time.time())


def manifest(path):
    with open(path, encoding='utf-8') as source:
        jobs = json.load(source)
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 10000:
        raise ValueError('manifest must contain 1..10000 items')
    seen = set()
    for job in jobs:
        if not isinstance(job, dict) or set(job) != {'id', 'argv'}:
            raise ValueError('each item must contain exactly id and argv')
        ident, argv = job['id'], job['argv']
        if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', ident):
            raise ValueError('item id must be 1..64 letters, digits, dots, underscores or hyphens')
        if ident in seen:
            raise ValueError('duplicate item id')
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and '\x00' not in a for a in argv) or not argv[0]:
            raise ValueError('argv must be a nonempty string array without NUL')
        seen.add(ident)
    digest = hashlib.sha256(json.dumps(jobs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return jobs, digest


def kill(proc):
    # 每项是独立进程组，超时后一起终止它及普通子进程。
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def stop_policy(args):
    policy = {}
    if args.stop_on_exit is not None:
        policy['exitCode'] = args.stop_on_exit
    if args.stop_on_match is not None:
        if not args.stop_on_match:
            raise ValueError('--stop-on-match must not be empty')
        try:
            re.compile(args.stop_on_match)
        except re.error as error:
            raise ValueError('invalid --stop-on-match: ' + str(error)) from None
        policy['match'] = args.stop_on_match
    if args.stop_on_file:
        policy['file'] = str(Path(args.stop_on_file).absolute())
    return policy


def matched(item, policy):
    # 只检查自然结束的单项；超时留下的半截输出不能充当命中。
    if item['status'] not in ('completed', 'failed') or item.get('startError'):
        return None
    if 'exitCode' in policy and item['exitCode'] == policy['exitCode']:
        return {'kind': 'exit', 'itemId': item['id'], 'exitCode': item['exitCode'], 'log': item['log']}
    if 'match' in policy:
        pattern = re.compile(policy['match'])
        with open(item['log'], encoding='utf-8', errors='replace') as output:
            if any(pattern.search(line) for line in output):
                return {'kind': 'match', 'itemId': item['id'], 'log': item['log']}
    return None


def latch_stop(directory, state, reason):
    if state.get('stop'):
        return
    state['stop'] = reason
    state['status'] = 'matched' if reason['kind'] != 'file' else 'stopped'
    for item in state['items']:
        if item['status'] == 'pending':
            item['status'] = 'skipped'
    # 命中与停发一同持久化；重启、重复 run 或条件文件消失都不会悄悄恢复枚举。
    save(directory, state)
    emit({'status': state['status'], 'stop': reason})


def run(args):
    start = time.monotonic()
    outer = remaining()
    if args.budget is None and outer is None:
        raise ValueError('background/standalone run requires --budget seconds')
    budget = args.budget if args.budget is not None else outer
    if outer is not None:
        budget = min(budget, outer)
    deadline = start + max(0, budget - args.reserve)
    jobs, digest = manifest(args.manifest)
    policy = stop_policy(args)
    directory = Path(args.state).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('batch already running; use status or wait') from None
        if (directory / 'state.json').exists():
            state = read(directory)
            if state.get('version') != 1 or state.get('manifest') != digest or state.get('cwd') != os.getcwd():
                raise ValueError('manifest changed or working directory changed; use a new state directory')
            if policy and policy != state.get('stopOn', {}):
                raise ValueError('stop conditions changed; use a new state directory')
            policy = state.get('stopOn', {})
            for item in state['items']:
                if item['status'] == 'running':
                    item['status'] = 'unknown'
        else:
            state = {'version': 1, 'manifest': digest, 'cwd': os.getcwd(), 'status': 'pending',
                     'stopOn': policy,
                     'items': [{'id': job['id'], 'status': 'pending', 'attempts': 0} for job in jobs]}
        if state.get('stop'):
            if args.retry:
                raise ValueError('batch already stopped; changed conditions require a new state directory')
            save(directory, state)
            emit(state)
            return 0
        # 上次可能在保存单项结果后、记录停止原因前退出；先从已保存结果补齐熔断。
        for item in state['items']:
            reason = matched(item, policy)
            if reason:
                latch_stop(directory, state, reason)
                emit(state)
                return 0
        by_id = {item['id']: item for item in state['items']}
        for ident in args.retry:
            if ident not in by_id or by_id[ident]['status'] not in ('failed', 'timed_out', 'unknown', 'cancelled'):
                raise ValueError('--retry requires a failed, timed_out, unknown or cancelled item id')
        for ident in args.retry:
            by_id[ident]['status'] = 'pending'
        todo = [(job, by_id[job['id']]) for job in jobs if by_id[job['id']]['status'] == 'pending']
        state['status'] = 'running'
        state['budgetSeconds'] = budget
        state['reserveSeconds'] = args.reserve
        save(directory, state)
        active = []
        stopped = False

        def stop(_signum, _frame):
            nonlocal stopped
            stopped = True

        previous = {s: signal.signal(s, stop) for s in (signal.SIGTERM, signal.SIGINT)}
        next_start = start
        try:
            while todo or active:
                now = time.monotonic()
                if policy.get('file') and Path(policy['file']).is_file():
                    latch_stop(directory, state, {'kind': 'file', 'path': policy['file']})
                # 先收割完成结果再填并发空位，避免已经命中还多派发一轮。
                for entry in list(active):
                    proc, log, item, began = entry
                    code = proc.poll()
                    timed_out = now - began >= args.item_timeout or now >= deadline
                    if code is None and not (stopped or timed_out):
                        continue
                    if code is None:
                        kill(proc)
                        code = proc.wait()
                        item['status'] = 'cancelled' if stopped else 'timed_out'
                    else:
                        item['status'] = 'completed' if code == 0 else 'failed'
                        # 每项必须是有限任务；主进程结束后不遗留仍占用并发名额的普通子进程。
                        kill(proc)
                    log.close()
                    item['exitCode'] = code
                    item['durationSeconds'] = round(time.monotonic() - began, 3)
                    active.remove(entry)
                    save(directory, state)
                    emit({'id': item['id'], 'status': item['status'], 'log': item['log']})
                    reason = matched(item, policy)
                    if reason:
                        latch_stop(directory, state, reason)
                now = time.monotonic()
                while (todo and not stopped and not state.get('stop') and len(active) < args.concurrency
                       and now >= next_start and deadline - now >= args.item_timeout):
                    if policy.get('file') and Path(policy['file']).is_file():
                        latch_stop(directory, state, {'kind': 'file', 'path': policy['file']})
                        break
                    job, item = todo.pop(0)
                    item['attempts'] += 1
                    item['status'] = 'running'
                    item.pop('exitCode', None)
                    item.pop('durationSeconds', None)
                    item.pop('startError', None)
                    item['log'] = str(directory / (item['id'] + '.' + str(item['attempts']) + '.log'))
                    save(directory, state)
                    # 落盘也占预算；记录意图后再核对一次，不能把写盘耗时漏掉。
                    if stopped or deadline - time.monotonic() < args.item_timeout:
                        item.update(status='pending', attempts=item['attempts'] - 1)
                        todo.insert(0, (job, item))
                        save(directory, state)
                        break
                    if policy.get('file') and Path(policy['file']).is_file():
                        item.update(status='pending', attempts=item['attempts'] - 1)
                        latch_stop(directory, state, {'kind': 'file', 'path': policy['file']})
                        break
                    log = open(item['log'], 'ab', buffering=0)
                    try:
                        # runner 意外被杀时，只要该项还在运行就继续持锁，防止恢复时并发重放。
                        proc = subprocess.Popen(job['argv'], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                                start_new_session=True, close_fds=True, pass_fds=(lock.fileno(),))
                    except OSError as error:
                        log.write(str(error).encode())
                        log.close()
                        item.update(status='failed', exitCode=127, durationSeconds=0, startError=True)
                        save(directory, state)
                    else:
                        active.append((proc, log, item, time.monotonic()))
                    next_start = time.monotonic() + args.delay
                    now = time.monotonic()
                if not active and (stopped or state.get('stop') or not todo
                                   or deadline - time.monotonic() < args.item_timeout):
                    break
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            statuses = {item['status'] for item in state['items']}
            state['status'] = (('stopped' if state['stop']['kind'] == 'file' else 'matched') if state.get('stop') else
                               'completed' if statuses == {'completed'} else
                               'cancelled' if stopped else 'paused' if 'pending' in statuses else 'needs_review')
            save(directory, state)
            emit(state)
            return 0 if state['status'] in ('completed', 'matched', 'stopped') else 3
        finally:
            for proc, log, _item, _began in active:
                kill(proc)
                proc.wait()
                log.close()
            for signum, handler in previous.items():
                signal.signal(signum, handler)


def main():
    parser = argparse.ArgumentParser(
        prog='melina-batch', description='Bounded batches with persistent item results; no automatic retries.',
        epilog='Manifest: [{"id":"case-1","argv":["python3","probe.py","value"]}]. '
               'Same manifest + --state resumes pending items only. Inspect logs before --retry ID.')
    commands = parser.add_subparsers(dest='operation', required=True)
    runner = commands.add_parser('run', help='execute or resume pending items within a total budget')
    runner.add_argument('manifest')
    runner.add_argument('--budget', type=positive, help='total seconds; required in background; capped by sh deadline')
    runner.add_argument('--reserve', type=positive, default=2, help='seconds reserved before the outer deadline (default 2)')
    runner.add_argument('--item-timeout', type=positive, default=10, help='per-item seconds; must fit remaining budget')
    runner.add_argument('--concurrency', type=int, choices=range(1, 17), default=1)
    runner.add_argument('--delay', type=nonnegative, default=0, help='minimum seconds between item starts')
    runner.add_argument('--retry', action='append', default=[], metavar='ID', help='explicitly retry after checking effects')
    runner.add_argument('--stop-on-exit', type=int, choices=range(256), metavar='CODE',
                        help='stop dispatching when a finished item exits with CODE (opt-in success criterion)')
    runner.add_argument('--stop-on-match', metavar='REGEX',
                        help='stop dispatching when a line in a finished item log matches REGEX')
    runner.add_argument('--stop-on-file', metavar='PATH',
                        help='stop dispatching when an external result/stop marker file exists; its contents stay private')
    status = commands.add_parser('status', help='read saved results without waiting')
    waiter = commands.add_parser('wait', help='wait until runner finishes or the short wait expires')
    waiter.add_argument('--seconds', type=nonnegative, default=10, help='wait at most 30 seconds, also capped by sh deadline')
    for command in (runner, status, waiter):
        command.add_argument('--state', required=True, help='persistent directory unique to this manifest')
    args = parser.parse_args()
    try:
        if args.operation == 'run':
            return run(args)
        directory = Path(args.state).resolve()
        seconds = min(args.seconds, 30) if args.operation == 'wait' else 0
        outer = remaining()
        if outer is not None:
            seconds = min(seconds, max(0, outer - 1))
        deadline = time.monotonic() + seconds
        while True:
            state = snapshot(directory)
            if (not state['active'] and state['status'] != 'not_started') or time.monotonic() >= deadline:
                emit(state)
                return 0
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('melina-batch: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
