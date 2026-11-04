# 对外内容和内部发布稿。公开的放在 /api/public 下；发布稿是草稿，上线前内部才看。
# 这个蓝图自己用一个 before_request 放行公开的、其余要登录。

from miniweb import Blueprint, abort, g, jsonify, request

from app.security import db

bp = Blueprint("content", url_prefix="")


@bp.before_request
def gate():
    if request.path.startswith("/api/public"):
        return None
    if g.user is None:
        abort(401)
    return None


@bp.route("/api/public/status")
def public_status():
    return jsonify({"status": "ok", "version": "4.2.0"})


@bp.route("/api/public/plans")
def public_plans():
    return jsonify([{"id": "free", "price": 0}, {"id": "pro", "price": 99}])


@bp.route("/api/publications/<pub_id>")
def get_publication(pub_id):
    pub = db().publications.get(pub_id)
    if pub is None:
        abort(404)
    return jsonify(pub)
