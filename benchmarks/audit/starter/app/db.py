# 内存数据层：每次 create_app() 建一份新的种子数据（互不影响）。
# 一些布尔字段（staff、active）是从旧的配置表里导进来的，当时就存成了字符串 "true"/"false"。

from copy import deepcopy
from itertools import count


class DB:
    def __init__(self, data):
        self.users = data["users"]
        self.teams = data["teams"]
        self.projects = data["projects"]
        self.tasks = data["tasks"]
        self.files = data["files"]
        self.invoices = data["invoices"]
        self.notes = data["notes"]
        self.reports = data["reports"]
        self.webhooks = data["webhooks"]
        self.publications = data["publications"]
        self.flags = data["flags"]
        self.tokens = data["tokens"]
        self._ids = count(101)

    def new_id(self, prefix):
        """新建记录的编号：一份数据里递增、不复用（删掉的编号不会再发出去）。"""
        return f"{prefix}_{next(self._ids)}"


_SEED = {
    "users": {
        "u_alice": {"id": "u_alice", "name": "Alice", "email": "alice@acme.test", "password": "alice-pw-2026", "role": "user", "team": "t_alpha", "staff": "false", "active": "true"},
        "u_bob": {"id": "u_bob", "name": "Bob", "email": "bob@acme.test", "password": "bob-pw-2026", "role": "user", "team": "t_beta", "staff": "false", "active": "true"},
        "u_carol": {"id": "u_carol", "name": "Carol", "email": "carol@acme.test", "password": "carol-pw-2026", "role": "admin", "team": "t_ops", "staff": "true", "active": "true"},
    },
    "teams": {
        "t_alpha": {"id": "t_alpha", "name": "Alpha", "members": ["u_alice"]},
        "t_beta": {"id": "t_beta", "name": "Beta", "members": ["u_bob"]},
        "t_ops": {"id": "t_ops", "name": "Ops", "members": ["u_carol"]},
    },
    "projects": {
        "p_alpha": {"id": "p_alpha", "name": "Alpha 改版", "team": "t_alpha", "owner": "u_alice", "members": ["u_alice"]},
        "p_beta": {"id": "p_beta", "name": "Beta 上线", "team": "t_beta", "owner": "u_bob", "members": ["u_bob"]},
    },
    "tasks": {
        "tsk_alpha": {"id": "tsk_alpha", "project": "p_alpha", "owner": "u_alice", "title": "写文档", "done": False},
        "tsk_beta": {"id": "tsk_beta", "project": "p_beta", "owner": "u_bob", "title": "配置域名", "done": False},
    },
    "files": {
        "f_alpha": {"id": "f_alpha", "owner": "u_alice", "name": "alpha.pdf", "bytes": 1024},
        "f_beta": {"id": "f_beta", "owner": "u_bob", "name": "beta.pdf", "bytes": 2048},
    },
    "invoices": {
        "inv_alpha": {"id": "inv_alpha", "owner": "u_alice", "amount": "1200.00", "customer": "Alpha 客户"},
        "inv_beta": {"id": "inv_beta", "owner": "u_bob", "amount": "888.00", "customer": "Beta 客户"},
    },
    "notes": {
        "n_alpha": {"id": "n_alpha", "owner": "u_alice", "text": "alpha 的备忘"},
        "n_beta": {"id": "n_beta", "owner": "u_bob", "text": "beta 的备忘"},
    },
    "reports": {
        "r_alpha": {"id": "r_alpha", "owner": "u_alice", "title": "Alpha 季度", "amount": 1200},
        "r_beta": {"id": "r_beta", "owner": "u_bob", "title": "Beta 季度", "amount": 888},
    },
    "webhooks": {
        "wh_alpha": {"id": "wh_alpha", "owner": "u_alice", "url": "https://alpha.test/hook", "secret": "sek_alpha"},
        "wh_beta": {"id": "wh_beta", "owner": "u_bob", "url": "https://beta.test/hook", "secret": "sek_beta"},
    },
    # 内部草稿，上线前不对外；对外的那几篇在 /api/public 下。
    "publications": {
        "pub_alpha": {"id": "pub_alpha", "title": "Alpha 发布说明（草稿）", "status": "draft", "body": "尚未公开"},
    },
    "flags": {"beta_checkout": False, "new_dashboard": True},
    "tokens": {"tok_alice": "u_alice", "tok_bob": "u_bob", "tok_carol": "u_carol"},
}


def seed_db():
    return DB(deepcopy(_SEED))
