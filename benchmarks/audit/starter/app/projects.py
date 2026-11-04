# 项目和项目下的任务。整个蓝图用一个 before_request 要求登录，具体的归属在各个函数体里查。
# 列表只返回自己参与的项目。

from miniweb import Blueprint, abort, g, jsonify

from app.security import db, json_body

bp = Blueprint("projects", url_prefix="/api/projects")


@bp.before_request
def require_login():
    if g.user is None:
        abort(401)


def _member(project):
    return project is not None and g.user["id"] in project["members"]


@bp.route("")
def list_projects():
    mine = [p for p in db().projects.values() if g.user["id"] in p["members"]]
    return jsonify(mine)


@bp.route("", methods=["POST"])
def create_project():
    body = json_body()
    pid = db().new_id("p")
    proj = {"id": pid, "name": body.get("name", ""), "team": g.user.get("team"), "owner": g.user["id"], "members": [g.user["id"]]}
    db().projects[pid] = proj
    return jsonify(proj, status=201)


@bp.route("/<project_id>")
def get_project(project_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    return jsonify(proj)


@bp.route("/<project_id>", methods=["PATCH"])
def update_project(project_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    if proj["owner"] != g.user["id"]:
        abort(403)
    proj["name"] = json_body().get("name", proj["name"])
    return jsonify(proj)


@bp.route("/<project_id>", methods=["DELETE"])
def delete_project(project_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    if proj["owner"] != g.user["id"]:
        abort(403)
    db().projects.pop(project_id)
    return "", 204


@bp.route("/<project_id>/tasks")
def list_tasks(project_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    tasks = [t for t in db().tasks.values() if t["project"] == project_id]
    return jsonify(tasks)


@bp.route("/<project_id>/tasks", methods=["POST"])
def create_task(project_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    tid = db().new_id("tsk")
    task = {"id": tid, "project": project_id, "owner": g.user["id"], "title": json_body().get("title", ""), "done": False}
    db().tasks[tid] = task
    return jsonify(task, status=201)


@bp.route("/<project_id>/tasks/<task_id>", methods=["PATCH"])
def update_task(project_id, task_id):
    proj = db().projects.get(project_id)
    if not _member(proj):
        abort(404)
    task = db().tasks.get(task_id)
    if task is None:
        abort(404)
    body = json_body()
    if "title" in body:
        task["title"] = body["title"]
    if "done" in body:
        task["done"] = body["done"]
    return jsonify(task)
