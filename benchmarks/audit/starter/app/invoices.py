# 发票。列表只给自己的；取单张、取 PDF 按 id。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body, login_required

bp = Blueprint("invoices", url_prefix="/api/invoices")


@bp.route("")
@login_required
def list_invoices():
    mine = [i for i in db().invoices.values() if i["owner"] == g.user["id"]]
    return jsonify(mine)


@bp.route("", methods=["POST"])
@login_required
def create_invoice():
    body = json_body()
    iid = db().new_id("inv")
    rec = {"id": iid, "owner": g.user["id"], "amount": body.get("amount", "0.00"), "customer": body.get("customer", "")}
    db().invoices[iid] = rec
    return jsonify(rec, status=201)


@bp.route("/<invoice_id>")
@login_required
def get_invoice(invoice_id):
    inv = db().invoices.get(invoice_id)
    if inv is None:
        abort(404)
    return jsonify(inv)


@bp.route("/<invoice_id>/pdf")
@login_required
def invoice_pdf(invoice_id):
    inv = db().invoices.get(invoice_id)
    if inv is None:
        abort(404)
    if inv["owner"] != g.user["id"]:
        abort(403)
    return jsonify({"id": inv["id"], "pdf": "/pdf/" + inv["id"]})
