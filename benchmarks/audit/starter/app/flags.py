# 功能开关。谁都能读；改开关是内部员工（staff）的事。

from miniweb import Blueprint, abort, g, jsonify

from app.security import cache_response, db, json_body, login_required

bp = Blueprint("flags", url_prefix="/api/flags")


def _can_manage_flags():
    u = g.user
    return bool(u and u.get("staff"))


@cache_response
@bp.route("")
@login_required
def list_flags():
    return jsonify(db().flags)


@bp.route("/<flag>", methods=["PUT"])
@login_required
def set_flag(flag):
    if not _can_manage_flags():
        abort(403)
    db().flags[flag] = bool(json_body().get("value"))
    return jsonify({"flag": flag, "value": db().flags[flag]})
