# v1 兼容层：把老的路径映射到现有实现，给还没迁移的客户端用。
# 用 add_url_rule 直接挂函数：/api/v1/me 挂的是 auth 里包过装饰器的 me；报表挂的是内部实现 _report_detail。

from miniweb import Blueprint

from app.auth import me as auth_me
from app.reports import _report_detail

bp = Blueprint("compat_v1", url_prefix="/api/v1")

bp.add_url_rule("/me", "v1_me", auth_me, methods=["GET"])
bp.add_url_rule("/reports/<report_id>", "v1_report", _report_detail, methods=["GET"])
