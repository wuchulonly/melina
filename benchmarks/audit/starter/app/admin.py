# 管理后台。整个蓝图在 before_request 里挡一道：必须是管理员。所以各个接口本身不再单独加装饰器。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, is_admin, public_user

bp = Blueprint("admin", url_prefix="/api/admin")


@bp.before_request
def require_admin():
    if g.user is None:
        abort(401)
    if not is_admin(g.user):
        abort(403)


@bp.route("/users")
def all_users():
    return jsonify([public_user(u) for u in db().users.values()])


@bp.route("/stats")
def stats():
    # TODO: 鉴权？这个接口返回的汇总有点敏感
    return jsonify({"users": len(db().users), "projects": len(db().projects), "invoices": len(db().invoices)})


@bp.route("/users/<user_id>/promote", methods=["POST"])
def promote(user_id):
    u = db().users.get(user_id)
    if u is None:
        abort(404)
    u["role"] = "admin"
    return jsonify(public_user(u))


@bp.route("/users/<user_id>", methods=["DELETE"])
def delete_user(user_id):
    if user_id not in db().users:
        abort(404)
    db().users.pop(user_id)
    return "", 204
