# 组装应用：建一份新的内存数据，注册一个全局 before_request 认人（只认不拦），再把各蓝图挂上。
# 拦截（要不要登录、是不是本人、是不是管理员）由各蓝图自己的装饰器或钩子负责。

from miniweb import MiniApp, g, request

from app.db import seed_db


def create_app():
    app = MiniApp()
    app.db = seed_db()

    @app.before_request
    def load_user():
        g.user = None
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            uid = app.db.tokens.get(auth[len("Bearer "):])
            if uid:
                g.user = app.db.users.get(uid)
        return None

    from app import (
        admin,
        auth,
        compat_v1,
        content,
        files,
        flags,
        invoices,
        notes,
        projects,
        reports,
        teams,
        users,
        webhooks,
    )

    for module in (auth, users, teams, projects, files, invoices, notes, reports, webhooks, flags, admin, content, compat_v1):
        app.register_blueprint(module.bp)

    return app
