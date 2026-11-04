# 用户。普通用户只能看/改自己；列全部用户、改别人是管理员的事。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body, login_required, public_user, require_role

bp = Blueprint("users", url_prefix="/api/users")


@bp.route("")
@require_role("admin")
def list_users():
    return jsonify([public_user(u) for u in db().users.values()])


@bp.route("/me")
@login_required
def get_me():
    return jsonify(public_user(g.user))


@bp.route("/me", methods=["PATCH"])
@login_required
def update_me():
    body = json_body()
    # 资料页提交上来的字段写回用户
    g.user.update(body)
    return jsonify(public_user(g.user))


@bp.route("/<user_id>")
@require_role("admin")
def get_user(user_id):
    u = db().users.get(user_id)
    if u is None:
        abort(404)
    return jsonify(public_user(u))


@bp.route("/<user_id>", methods=["PATCH"])
@require_role("admin")
def update_user(user_id):
    u = db().users.get(user_id)
    if u is None:
        abort(404)
    u.update(json_body())
    return jsonify(public_user(u))
