# 团队。只能看自己所在的团队；不是成员就当查不到。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, login_required

bp = Blueprint("teams", url_prefix="/api/teams")


@bp.route("")
@login_required
def list_teams():
    mine = [t for t in db().teams.values() if g.user["id"] in t["members"]]
    return jsonify(mine)


@bp.route("/<team_id>")
@login_required
def get_team(team_id):
    t = db().teams.get(team_id)
    if t is None or g.user["id"] not in t["members"]:
        abort(404)
    return jsonify(t)
