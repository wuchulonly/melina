# 一个很小的 Web 框架，用法仿照 Flask：Blueprint、route 装饰器、before_request 钩子、g、request、abort、
# JSON 响应、test_client()。只用 Python 标准库，没有线程、没有 WSGI，够内部服务跑测试用。
#
# 一个要紧的地方：route 装饰器注册的就是它收到的那个函数（原样返回，不再包一层）。所以
#   @bp.route(...)       # 注册的是下面那个（已经被下面的装饰器包过的）函数
#   @login_required
#   def view(): ...
# 和
#   @login_required
#   @bp.route(...)       # 注册的是还没被 login_required 包过的函数
#   def view(): ...
# 行为不一样，和真正的 WSGI 框架一致。

import json as _json
from functools import wraps  # noqa: F401  （给上层模块转导出用）
from types import SimpleNamespace

__all__ = [
    "Blueprint",
    "MiniApp",
    "Response",
    "abort",
    "current_app",
    "g",
    "jsonify",
    "request",
    "wraps",
]


class HTTPException(Exception):
    """abort() 抛出来的，dispatcher 接住，变成对应状态码的响应。"""

    def __init__(self, status, message=None):
        super().__init__(message or str(status))
        self.status = status
        self.message = message or _STATUS_TEXT.get(status, "error")


_STATUS_TEXT = {
    200: "ok",
    201: "created",
    204: "no content",
    400: "bad request",
    401: "unauthorized",
    403: "forbidden",
    404: "not found",
    405: "method not allowed",
}


def abort(status, message=None):
    raise HTTPException(status, message)


class Response:
    def __init__(self, body="", status=200, headers=None, is_json=False):
        self.status = status
        self.headers = {} if headers is None else dict(headers)
        self._is_json = is_json
        if isinstance(body, (bytes, bytearray)):
            self.body = body.decode("utf-8")
        else:
            self.body = body

    def get_json(self):
        if not self.body:
            return None
        try:
            return _json.loads(self.body)
        except ValueError:
            return None

    @property
    def json(self):
        return self.get_json()


def jsonify(obj, status=200):
    return Response(_json.dumps(obj, ensure_ascii=False), status=status, headers={"Content-Type": "application/json"}, is_json=True)


class Request:
    def __init__(self, method, path, headers=None, body=b"", query=""):
        self.method = method.upper()
        self.path = path
        self.query_string = query
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._body = body if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
        self._json_cache = _UNSET

    @property
    def headers(self):
        return _HeaderView(self._headers)

    @property
    def data(self):
        return self._body

    def get_json(self, silent=True):
        if self._json_cache is _UNSET:
            try:
                self._json_cache = _json.loads(self._body.decode("utf-8")) if self._body else None
            except ValueError:
                if not silent:
                    raise
                self._json_cache = None
        return self._json_cache

    @property
    def json(self):
        return self.get_json()


_UNSET = object()


class _HeaderView:
    def __init__(self, d):
        self._d = d

    def get(self, name, default=None):
        return self._d.get(name.lower(), default)

    def __getitem__(self, name):
        return self._d[name.lower()]

    def __contains__(self, name):
        return name.lower() in self._d


# ── 请求上下文：g、request、current_app 都是指向「当前请求」的代理 ───────────────────

_ctx_stack = []


class _Ctx:
    def __init__(self, app, req):
        self.app = app
        self.request = req
        self.g = SimpleNamespace()


class _CtxProxy:
    """把属性/下标访问转发到当前请求上下文里的某个对象（g、request 或 app）。"""

    def __init__(self, attr):
        object.__setattr__(self, "_attr", attr)

    def _obj(self):
        if not _ctx_stack:
            raise RuntimeError("不在请求上下文里")
        return getattr(_ctx_stack[-1], object.__getattribute__(self, "_attr"))

    def __getattr__(self, name):
        return getattr(self._obj(), name)

    def __setattr__(self, name, value):
        setattr(self._obj(), name, value)

    def __getitem__(self, key):
        return self._obj()[key]

    def __setitem__(self, key, value):
        self._obj()[key] = value

    def __contains__(self, key):
        return key in self._obj()


g = _CtxProxy("g")
request = _CtxProxy("request")
current_app = _CtxProxy("app")


# ── 路由、蓝图、应用 ──────────────────────────────────────────────────────────


def _normalize(path):
    if path != "/" and path.endswith("/"):
        return path[:-1]
    return path


class Rule:
    def __init__(self, path, methods, view, blueprint):
        self.path = _normalize(path)
        self.segments = self.path.strip("/").split("/") if self.path != "/" else [""]
        self.methods = [m.upper() for m in methods]
        self.view = view
        self.blueprint = blueprint

    def match(self, path):
        segs = path.strip("/").split("/") if path != "/" else [""]
        if len(segs) != len(self.segments):
            return None
        args = {}
        static_hits = 0
        for pat, got in zip(self.segments, segs):
            if pat.startswith("<") and pat.endswith(">"):
                args[pat[1:-1]] = got
            elif pat == got:
                static_hits += 1
            else:
                return None
        return static_hits, args


class Blueprint:
    def __init__(self, name, url_prefix=""):
        self.name = name
        self.url_prefix = url_prefix.rstrip("/")
        self.deferred = []  # (path, methods, view)
        self.before_funcs = []

    def route(self, path, methods=("GET",)):
        def deco(fn):
            self.add_url_rule(path, fn.__name__, fn, methods=methods)
            return fn  # 原样返回：注册的就是收到的这个函数

        return deco

    def add_url_rule(self, path, endpoint, view_func, methods=("GET",)):
        full = (self.url_prefix + path) if self.url_prefix else path
        self.deferred.append((_normalize(full), tuple(methods), view_func))
        return view_func

    def before_request(self, fn):
        self.before_funcs.append(fn)
        return fn


class MiniApp:
    def __init__(self):
        self.rules = []
        self.before_funcs = []
        self.db = None

    def before_request(self, fn):
        self.before_funcs.append(fn)
        return fn

    def register_blueprint(self, bp):
        for path, methods, view in bp.deferred:
            self.rules.append(Rule(path, methods, view, bp))

    def routes(self):
        out = set()
        for rule in self.rules:
            for m in rule.methods:
                out.add(f"{m} {rule.path}")
        return sorted(out)

    def _find(self, method, path):
        path = _normalize(path)
        best = None
        best_score = -1
        method_seen = False
        for rule in self.rules:
            m = rule.match(path)
            if m is None:
                continue
            score, args = m
            if method.upper() not in rule.methods:
                method_seen = True
                continue
            if score > best_score:
                best = (rule, args)
                best_score = score
        if best is None:
            abort(405 if method_seen else 404)
        return best

    def dispatch(self, req):
        ctx = _Ctx(self, req)
        _ctx_stack.append(ctx)
        try:
            try:
                rule, args = self._find(req.method, req.path)
                for fn in self.before_funcs:
                    rv = fn()
                    if rv is not None:
                        return _to_response(rv)
                for fn in rule.blueprint.before_funcs:
                    rv = fn()
                    if rv is not None:
                        return _to_response(rv)
                return _to_response(rule.view(**args))
            except HTTPException as e:
                return jsonify({"error": e.message}, status=e.status)
        finally:
            _ctx_stack.pop()

    def test_client(self):
        return TestClient(self)


def _to_response(rv):
    if isinstance(rv, Response):
        return rv
    status = 200
    if isinstance(rv, tuple):
        rv, status = rv[0], rv[1]
    if isinstance(rv, (dict, list)):
        return jsonify(rv, status=status)
    if rv is None or rv == "":
        return Response("", status=status)
    return Response(str(rv), status=status, headers={"Content-Type": "text/plain"})


class TestClient:
    def __init__(self, app):
        self.app = app
        self.application = app

    def open(self, method, path, headers=None, json=None, data=None):
        query = ""
        if "?" in path:
            path, query = path.split("?", 1)
        hdrs = dict(headers or {})
        body = b""
        if json is not None:
            body = _json.dumps(json).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        elif data is not None:
            body = data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")
        return self.app.dispatch(Request(method, path, hdrs, body, query))

    def get(self, path, **kw):
        return self.open("GET", path, **kw)

    def post(self, path, **kw):
        return self.open("POST", path, **kw)

    def put(self, path, **kw):
        return self.open("PUT", path, **kw)

    def patch(self, path, **kw):
        return self.open("PATCH", path, **kw)

    def delete(self, path, **kw):
        return self.open("DELETE", path, **kw)
