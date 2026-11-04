# 报表。列表、单张都要登录并且是本人；汇总是给首页用的小数字。
# _report_detail 是早期内部实现，v1 兼容层还在用它。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, login_required

bp = Blueprint("reports", url_prefix="/api/reports")


def _report_detail(report_id):
    r = db().reports.get(report_id)
    if r is None:
        abort(404)
    return jsonify(r)


@bp.route("")
@login_required
def list_reports():
    mine = [r for r in db().reports.values() if r["owner"] == g.user["id"]]
    return jsonify(mine)


@bp.route("/summary")
def reports_summary():
    reports = db().reports.values()
    total = sum(r["amount"] for r in reports)
    return jsonify({"count": len(db().reports), "total": total})


@bp.route("/<report_id>")
@login_required
def get_report(report_id):
    r = db().reports.get(report_id)
    if r is None:
        abort(404)
    if r["owner"] != g.user["id"]:
        abort(403)
    return _report_detail(report_id)
