# 命令行工具，方便手工探接口：
#   python -m app routes
#       列出全部路由，一行一个「METHOD 路径模板」，同一路径不同方法分行。
#   python -m app call METHOD PATH [--as alice|bob|carol|anon] [--json '{"k": 1}']
#       新建一份数据，发一个请求，打印状态码和返回体。
#   python -m app seq FILE
#       读一串请求（JSON 数组，每项 {"method","path","as","json"}），在同一份数据上依次发，
#       打印每个的状态码和返回体。用来看「先改后查」这种连着来的效果。
#
# 也可以直接用 Python：
#   from app import create_app
#   c = create_app().test_client()
#   c.get("/api/invoices/inv_beta", headers={"Authorization": "Bearer tok_alice"})

import json
import sys

from app import create_app

TOKENS = {"alice": "tok_alice", "bob": "tok_bob", "carol": "tok_carol", "anon": None}


def _headers(actor):
    token = TOKENS.get(actor, None)
    return {"Authorization": "Bearer " + token} if token else {}


def _print(resp):
    print("status:", resp.status)
    body = resp.body
    if body:
        print(body)


def _arg(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return default


def cmd_routes():
    for line in create_app().routes():
        print(line)


def cmd_call(args):
    if len(args) < 2:
        print("用法：python -m app call METHOD PATH [--as 身份] [--json '...']", file=sys.stderr)
        return 2
    method, path = args[0], args[1]
    actor = _arg(args, "--as", "anon")
    raw = _arg(args, "--json")
    body = json.loads(raw) if raw else None
    client = create_app().test_client()
    _print(client.open(method, path, headers=_headers(actor), json=body))
    return 0


def cmd_seq(args):
    if not args:
        print("用法：python -m app seq FILE", file=sys.stderr)
        return 2
    with open(args[0], encoding="utf-8") as fh:
        steps = json.load(fh)
    client = create_app().test_client()
    for i, step in enumerate(steps):
        resp = client.open(
            step["method"],
            step["path"],
            headers=_headers(step.get("as", "anon")),
            json=step.get("json"),
        )
        print(f"# {i} {step['method']} {step['path']} as={step.get('as', 'anon')} -> {resp.status}")
        if resp.body:
            print(resp.body)
    return 0


def main(argv):
    if not argv:
        print("用法：python -m app routes|call|seq ...", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "routes":
        cmd_routes()
        return 0
    if cmd == "call":
        return cmd_call(rest)
    if cmd == "seq":
        return cmd_seq(rest)
    print("未知命令：" + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
