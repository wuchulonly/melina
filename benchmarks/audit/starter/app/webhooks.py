# Webhook。增、删、列都是本人的；轮换密钥会返回新密钥。

import secrets

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body, login_required

bp = Blueprint("webhooks", url_prefix="/api/webhooks")


@bp.route("")
@login_required
def list_webhooks():
    mine = [w for w in db().webhooks.values() if w["owner"] == g.user["id"]]
    return jsonify(mine)


@bp.route("", methods=["POST"])
@login_required
def create_webhook():
    wid = db().new_id("wh")
    rec = {"id": wid, "owner": g.user["id"], "url": json_body().get("url", ""), "secret": "sek_" + secrets.token_hex(4)}
    db().webhooks[wid] = rec
    return jsonify(rec, status=201)


@bp.route("/<webhook_id>", methods=["DELETE"])
@login_required
def delete_webhook(webhook_id):
    w = db().webhooks.get(webhook_id)
    if w is None:
        abort(404)
    if w["owner"] != g.user["id"]:
        abort(403)
    db().webhooks.pop(webhook_id)
    return "", 204


@login_required
@bp.route("/<webhook_id>/rotate", methods=["POST"])
def rotate_secret(webhook_id):
    w = db().webhooks.get(webhook_id)
    if w is None:
        abort(404)
    w["secret"] = "sek_" + secrets.token_hex(4)
    return jsonify({"id": w["id"], "secret": w["secret"]})
