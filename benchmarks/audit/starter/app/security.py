# 鉴权用的装饰器和小工具。几个蓝图用这里的装饰器，另几个蓝图在 before_request 钩子里或者函数体里自己查。
# 鉴权约定见 docs/security.md。

from miniweb import abort, current_app, g, request, wraps


def current_user():
    return g.user


def login_required(fn):
    @wraps(fn)
    def wrapper(**kw):
        if g.user is None:
            abort(401)
        return fn(**kw)

    return wrapper


def require_role(role):
    """要求当前用户是某个角色（比如 admin）。"""

    def deco(fn):
        @wraps(fn)
        def wrapper(**kw):
            if g.user is None:
                abort(401)
            if g.user.get("role") != role:
                abort(403)
            return fn(**kw)

        return wrapper

    return deco


def require_owner(loader):
    """先按路由参数把资源取出来，不是本人就拒。取不到当不存在。"""

    def deco(fn):
        @wraps(fn)
        def wrapper(**kw):
            if g.user is None:
                abort(401)
            obj = loader(**kw)
            if obj is None:
                abort(404)
            if obj.get("owner") != g.user["id"]:
                abort(403)
            g.resource = obj
            return fn(**kw)

        return wrapper

    return deco


def cache_response(fn):
    """给 GET 响应加个弱缓存头，和鉴权无关。"""

    @wraps(fn)
    def wrapper(**kw):
        resp = fn(**kw)
        try:
            resp.headers["Cache-Control"] = "private, max-age=30"
        except AttributeError:
            pass
        return resp

    return wrapper


def is_admin(user):
    return bool(user) and user.get("role") == "admin"


def public_user(user):
    return {"id": user["id"], "name": user["name"], "role": user["role"], "team": user.get("team")}


def db():
    return current_app.db


def json_body():
    return request.get_json() or {}
