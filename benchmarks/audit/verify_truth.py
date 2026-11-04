#!/usr/bin/env python3
# 出题时用的真值核对脚本（不进 starter）。按 app 的路由表逐条探：
# 对每一条路由，用 anon / alice / bob / carol 实际发请求、并检查数据状态，判断它是不是越权。
# 1) 真值里的每一条都要能复现越权（拿到别人的数据，或者产生了不该有的效果）。
# 2) 不在真值里的每一条都不越权（匿名被拒、别人的数据拿不到也改不了、普通用户做不了管理员的事）。
# 3) 路由表里每一条都必须被覆盖；有没覆盖到的，报错退出。
# 跑通（集合完全对上）才 exit 0，并把确认过的真值集合打到 stdout（JSON），给单测对照。

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "starter"))

from app import create_app  # noqa: E402

TOKENS = {"alice": "tok_alice", "bob": "tok_bob", "carol": "tok_carol", "anon": None}

# 预期的越权清单（10 条）。verify_truth 用真实请求去证明它正好等于这个集合。
EXPECTED = {
    "PATCH /api/users/me",
    "GET /api/invoices/<invoice_id>",
    "PATCH /api/projects/<project_id>/tasks/<task_id>",
    "DELETE /api/files/<file_id>",
    "DELETE /api/notes/<note_id>",
    "GET /api/reports/summary",
    "POST /api/webhooks/<webhook_id>/rotate",
    "PUT /api/flags/<flag>",
    "GET /api/publications/<pub_id>",
    "GET /api/v1/reports/<report_id>",
}


def hdr(actor):
    tok = TOKENS.get(actor)
    return {"Authorization": "Bearer " + tok} if tok else {}


def run(actor, method, path, body=None):
    """新建一份数据，发一个请求，返回 (app, resp)，好顺带查 app.db 的状态。"""
    app = create_app()
    resp = app.test_client().open(method, path, headers=hdr(actor), json=body)
    return app, resp


def ok(resp):
    return 200 <= resp.status < 300


# ── 探子：返回 True 表示这条路由越权 ──────────────────────────────────────────


def anon_can(method, path, body=None):
    """匿名能成功调用 → 越权（公开接口不走这个探子）。"""
    _app, r = run("anon", method, path, body)
    return ok(r)


def cross(method, path_other, body=None, changed=None):
    """匿名或别人（alice 对 bob 的资源）能成功 → 越权。changed(app) 查有没有偷偷改到数据。"""
    for actor in ("anon", "alice"):
        app, r = run(actor, method, path_other, body)
        if ok(r):
            return True
        if changed is not None and changed(app):
            return True
    return False


def admin_only(method, path, body=None):
    """匿名或普通用户能成功 → 越权。"""
    for actor in ("anon", "alice"):
        _app, r = run(actor, method, path, body)
        if ok(r):
            return True
    return False


def never():
    return False


def login_without_password():
    """登录是公开接口，但只认邮箱、不认密码的话谁都能拿到管理员的令牌（会话 35 审查时补的探子）。"""
    for body in ({"email": "carol@acme.test"}, {"email": "carol@acme.test", "password": "wrong"}):
        _app, r = run("anon", "POST", "/api/auth/login", body)
        if ok(r):
            return True
    _app, r = run("anon", "POST", "/api/auth/login", {"email": "carol@acme.test", "password": "carol-pw-2026"})
    if not ok(r):
        raise SystemExit("登录接口用对的密码也登不上")
    return False


def clobbers(table, bob_path, alice_path, body):
    """新建会不会盖掉别人已有的记录（编号按「现有条数 + 1」算的实现删过以后会撞号）：
    bob 先建两条，删掉一条种子数据（不经过接口，模拟有人删过），alice 再建，看别人的记录有没有被改（会话 35 审查时补的探子）。"""
    app = create_app()
    c = app.test_client()
    store = getattr(app.db, table)
    for _ in range(2):
        c.open("POST", bob_path, headers=hdr("bob"), json=body)
    store.pop(next(iter(store)))
    before = json.dumps(store, sort_keys=True)
    c.open("POST", alice_path, headers=hdr("alice"), json=body)
    after = {k: v for k, v in store.items() if k in json.loads(before)}
    return json.dumps(after, sort_keys=True) != before


# 特定越权的探子（每个都复现一次具体的越权）

def v_users_me_patch():
    app, _r = run("alice", "PATCH", "/api/users/me", {"role": "admin"})
    return app.db.users["u_alice"]["role"] == "admin"


def v_invoice_get():
    _app, r = run("alice", "GET", "/api/invoices/inv_beta")
    return ok(r) and (r.json or {}).get("owner") == "u_bob"


def v_task_patch():
    app, _r = run("alice", "PATCH", "/api/projects/p_alpha/tasks/tsk_beta", {"title": "X"})
    return app.db.tasks["tsk_beta"]["title"] == "X"


def v_file_delete():
    app, _r = run("alice", "DELETE", "/api/files/f_beta")
    return "f_beta" not in app.db.files


def v_note_delete():
    app, _r = run("alice", "DELETE", "/api/notes/n_beta")
    return "n_beta" not in app.db.notes


def v_reports_summary():
    _app, r = run("anon", "GET", "/api/reports/summary")
    return ok(r)


def v_webhook_rotate():
    app, r = run("anon", "POST", "/api/webhooks/wh_alpha/rotate")
    return ok(r) and app.db.webhooks["wh_alpha"]["secret"] != "sek_alpha"


def v_flag_put():
    app, _r = run("alice", "PUT", "/api/flags/beta_checkout", {"value": True})
    return app.db.flags.get("beta_checkout") is True


def v_publication():
    _app, r = run("anon", "GET", "/api/publications/pub_alpha")
    return ok(r) and (r.json or {}).get("status") == "draft"


def v_v1_report():
    _app, r = run("anon", "GET", "/api/v1/reports/r_alpha")
    return ok(r) and (r.json or {}).get("id") == "r_alpha"


# ── 每条路由对应一个探子（路由表里每一条都要在这里） ─────────────────────────

PROBES = {
    # 公开接口：匿名本就该能访问，不算越权
    "GET /api/public/status": never,
    "GET /api/public/plans": never,
    "POST /api/auth/login": login_without_password,
    # 只要登录（匿名能进就是漏）
    "GET /api/auth/me": lambda: anon_can("GET", "/api/auth/me"),
    "POST /api/auth/logout": lambda: anon_can("POST", "/api/auth/logout"),
    "GET /api/users/me": lambda: anon_can("GET", "/api/users/me"),
    "GET /api/flags": lambda: anon_can("GET", "/api/flags"),
    "GET /api/files": lambda: anon_can("GET", "/api/files"),
    "POST /api/files": lambda: anon_can("POST", "/api/files", {"name": "x"})
    or clobbers("files", "/api/files", "/api/files", {"name": "x"}),
    "GET /api/invoices": lambda: anon_can("GET", "/api/invoices"),
    "POST /api/invoices": lambda: anon_can("POST", "/api/invoices", {"amount": "1.00"})
    or clobbers("invoices", "/api/invoices", "/api/invoices", {"amount": "1.00"}),
    "GET /api/notes": lambda: anon_can("GET", "/api/notes"),
    "POST /api/notes": lambda: anon_can("POST", "/api/notes", {"text": "x"})
    or clobbers("notes", "/api/notes", "/api/notes", {"text": "x"}),
    "GET /api/reports": lambda: anon_can("GET", "/api/reports"),
    "GET /api/teams": lambda: anon_can("GET", "/api/teams"),
    "GET /api/webhooks": lambda: anon_can("GET", "/api/webhooks"),
    "POST /api/webhooks": lambda: anon_can("POST", "/api/webhooks", {"url": "x"})
    or clobbers("webhooks", "/api/webhooks", "/api/webhooks", {"url": "x"}),
    "GET /api/projects": lambda: anon_can("GET", "/api/projects"),
    "POST /api/projects": lambda: anon_can("POST", "/api/projects", {"name": "x"})
    or clobbers("projects", "/api/projects", "/api/projects", {"name": "x"}),
    "GET /api/v1/me": lambda: anon_can("GET", "/api/v1/me"),
    # 要登录 + 归属（匿名或别人能拿到/改到就是漏）
    "GET /api/files/<file_id>": lambda: cross("GET", "/api/files/f_beta"),
    "GET /api/files/<file_id>/download": lambda: cross("GET", "/api/files/f_beta/download"),
    "GET /api/invoices/<invoice_id>/pdf": lambda: cross("GET", "/api/invoices/inv_beta/pdf"),
    "GET /api/notes/<note_id>": lambda: cross("GET", "/api/notes/n_beta"),
    "PUT /api/notes/<note_id>": lambda: cross(
        "PUT", "/api/notes/n_beta", {"text": "X"}, changed=lambda a: a.db.notes["n_beta"]["text"] == "X"
    ),
    "GET /api/reports/<report_id>": lambda: cross("GET", "/api/reports/r_beta"),
    "GET /api/teams/<team_id>": lambda: cross("GET", "/api/teams/t_beta"),
    "GET /api/projects/<project_id>": lambda: cross("GET", "/api/projects/p_beta"),
    "GET /api/projects/<project_id>/tasks": lambda: cross("GET", "/api/projects/p_beta/tasks"),
    "POST /api/projects/<project_id>/tasks": lambda: cross("POST", "/api/projects/p_beta/tasks", {"title": "X"})
    or clobbers("tasks", "/api/projects/p_beta/tasks", "/api/projects/p_alpha/tasks", {"title": "X"}),
    "PATCH /api/projects/<project_id>": lambda: cross(
        "PATCH", "/api/projects/p_beta", {"name": "X"}, changed=lambda a: a.db.projects["p_beta"]["name"] == "X"
    ),
    "DELETE /api/projects/<project_id>": lambda: cross(
        "DELETE", "/api/projects/p_beta", changed=lambda a: "p_beta" not in a.db.projects
    ),
    "DELETE /api/webhooks/<webhook_id>": lambda: cross(
        "DELETE", "/api/webhooks/wh_beta", changed=lambda a: "wh_beta" not in a.db.webhooks
    ),
    # 管理员专属（匿名或普通用户能成功就是漏）
    "GET /api/users": lambda: admin_only("GET", "/api/users"),
    "GET /api/users/<user_id>": lambda: admin_only("GET", "/api/users/u_bob"),
    "PATCH /api/users/<user_id>": lambda: admin_only("PATCH", "/api/users/u_bob", {"name": "X"}),
    "GET /api/admin/users": lambda: admin_only("GET", "/api/admin/users"),
    "GET /api/admin/stats": lambda: admin_only("GET", "/api/admin/stats"),
    "POST /api/admin/users/<user_id>/promote": lambda: admin_only("POST", "/api/admin/users/u_bob/promote"),
    "DELETE /api/admin/users/<user_id>": lambda: admin_only("DELETE", "/api/admin/users/u_bob"),
    # 越权的 10 条
    "PATCH /api/users/me": v_users_me_patch,
    "GET /api/invoices/<invoice_id>": v_invoice_get,
    "PATCH /api/projects/<project_id>/tasks/<task_id>": v_task_patch,
    "DELETE /api/files/<file_id>": v_file_delete,
    "DELETE /api/notes/<note_id>": v_note_delete,
    "GET /api/reports/summary": v_reports_summary,
    "POST /api/webhooks/<webhook_id>/rotate": v_webhook_rotate,
    "PUT /api/flags/<flag>": v_flag_put,
    "GET /api/publications/<pub_id>": v_publication,
    "GET /api/v1/reports/<report_id>": v_v1_report,
}


def sanity():
    """几条起码得成立的：业主能用自己的接口、公开接口匿名能开、管理员能进后台。"""
    problems = []
    _a, r = run("anon", "GET", "/api/public/status")
    if not ok(r):
        problems.append("匿名访问公开接口失败")
    _a, r = run("alice", "GET", "/api/invoices/inv_alpha")
    if not (ok(r) and (r.json or {}).get("owner") == "u_alice"):
        problems.append("业主访问自己的发票失败")
    _a, r = run("carol", "GET", "/api/admin/stats")
    if not ok(r):
        problems.append("管理员访问后台失败")
    return problems


def main():
    app = create_app()
    routes = set(app.routes())
    covered = set(PROBES)

    missing = routes - covered
    extra = covered - routes
    if missing or extra:
        print("路由覆盖不全：", file=sys.stderr)
        for r in sorted(missing):
            print("  路由表里有、探子里没有：" + r, file=sys.stderr)
        for r in sorted(extra):
            print("  探子里有、路由表里没有：" + r, file=sys.stderr)
        return 2

    problems = sanity()
    if problems:
        print("基本行为不对：" + "；".join(problems), file=sys.stderr)
        return 2

    found = {r for r in routes if PROBES[r]()}
    false_neg = EXPECTED - found  # 该漏却没探出来
    false_pos = found - EXPECTED  # 不该漏却探出来了（意料之外的漏洞）
    if false_neg or false_pos:
        print("真值对不上：", file=sys.stderr)
        for r in sorted(false_neg):
            print("  预期越权、但没能复现：" + r, file=sys.stderr)
        for r in sorted(false_pos):
            print("  意料之外的越权（题目有多余的洞）：" + r, file=sys.stderr)
        return 1

    print(json.dumps({"routes": len(routes), "vulnerable": sorted(found)}, ensure_ascii=False))
    print("真值核对通过：%d 条路由，%d 条越权，其余都挡住了。" % (len(routes), len(found)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
