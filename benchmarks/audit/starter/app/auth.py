# 登录、登出、看自己。登录是公开接口（见 docs/security.md）：邮箱加密码换令牌。

import hmac

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body, login_required, public_user

bp = Blueprint("auth", url_prefix="/api/auth")


@bp.route("/login", methods=["POST"])
def login():
    body = json_body()
    email = body.get("email")
    password = str(body.get("password") or "")
    for user in db().users.values():
        if user["email"] == email and password and hmac.compare_digest(user["password"], password):
            for token, uid in db().tokens.items():
                if uid == user["id"]:
                    return jsonify({"token": token, "user": public_user(user)})
    abort(401)


@bp.route("/logout", methods=["POST"])
@login_required
def logout():
    return jsonify({"ok": True})


@bp.route("/me")
@login_required
def me():
    return jsonify(public_user(g.user))
