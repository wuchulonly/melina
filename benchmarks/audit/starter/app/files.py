# 文件。看、下载走 require_owner 装饰器；删是早些时候手写的。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body, login_required, require_owner

bp = Blueprint("files", url_prefix="/api/files")


def _load(file_id):
    return db().files.get(file_id)


@bp.route("")
@login_required
def list_files():
    mine = [f for f in db().files.values() if f["owner"] == g.user["id"]]
    return jsonify(mine)


@bp.route("", methods=["POST"])
@login_required
def create_file():
    body = json_body()
    fid = db().new_id("f")
    rec = {"id": fid, "owner": g.user["id"], "name": body.get("name", ""), "bytes": body.get("bytes", 0)}
    db().files[fid] = rec
    return jsonify(rec, status=201)


@bp.route("/<file_id>")
@require_owner(_load)
def get_file(file_id):
    return jsonify(db().files[file_id])


@bp.route("/<file_id>/download")
@require_owner(_load)
def download_file(file_id):
    rec = db().files[file_id]
    return jsonify({"id": rec["id"], "name": rec["name"], "url": "/blob/" + rec["id"]})


@bp.route("/<file_id>", methods=["DELETE"])
@login_required
def delete_file(file_id):
    rec = db().files.pop(file_id, None)
    if rec is None:
        abort(404)
    if rec["owner"] != g.user["id"]:
        abort(403)
    return "", 204
