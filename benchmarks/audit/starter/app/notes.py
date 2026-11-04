# 便签。单条便签的读、改、删在一个函数里按方法分支。

from miniweb import Blueprint, abort, g, jsonify, request

from app.security import db, json_body, login_required

bp = Blueprint("notes", url_prefix="/api/notes")


@bp.route("")
@login_required
def list_notes():
    mine = [n for n in db().notes.values() if n["owner"] == g.user["id"]]
    return jsonify(mine)


@bp.route("", methods=["POST"])
@login_required
def create_note():
    nid = db().new_id("n")
    rec = {"id": nid, "owner": g.user["id"], "text": json_body().get("text", "")}
    db().notes[nid] = rec
    return jsonify(rec, status=201)


@bp.route("/<note_id>", methods=["GET", "PUT", "DELETE"])
@login_required
def note_detail(note_id):
    note = db().notes.get(note_id)
    if note is None:
        abort(404)
    if request.method in ("GET", "PUT"):
        if note["owner"] != g.user["id"]:
            abort(403)
    if request.method == "GET":
        return jsonify(note)
    if request.method == "PUT":
        note["text"] = json_body().get("text", note["text"])
        return jsonify(note)
    db().notes.pop(note_id, None)
    return "", 204
