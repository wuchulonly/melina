# acme-api

公司内部用的后台 API，基于自家的迷你框架 `miniweb`（用法仿 Flask）。数据在内存里，每次
`create_app()` 都是一份新的种子数据，方便本地跑和写测试。

模块（`app/` 下）：用户、团队、项目和任务、文件、发票、便签、报表、Webhook、功能开关、
管理后台、对外内容和内部发布稿、还有给老客户端用的 v1 兼容层。鉴权约定见
[`docs/security.md`](docs/security.md)。

## 跑起来

```sh
# 列出全部路由（一行一个「METHOD 路径模板」，同一路径不同方法分行）
python -m app routes

# 发一个请求（每次都是新的一份数据）
python -m app call GET /api/invoices/inv_alpha --as alice
python -m app call PATCH /api/users/me --as bob --json '{"name": "Bob B"}'
python -m app call GET /api/public/status --as anon

# 在同一份数据上依次发一串请求（看连着来的效果，比如先改再查）
python -m app seq requests.json
```

`seq` 读一个 JSON 数组，每项是 `{"method": ..., "path": ..., "as": ..., "json": ...}`，
`as` 可以是 `alice`、`bob`、`carol` 或 `anon`，在同一个 test client（同一份数据）上依次发。

也可以直接用 Python：

```python
from app import create_app
c = create_app().test_client()
r = c.get("/api/invoices/inv_beta", headers={"Authorization": "Bearer tok_alice"})
print(r.status, r.get_json())
```

## 跑测试

```sh
python3 -m unittest discover -s tests -t .
```

## 账号和令牌

| 用户 | id | 角色 | 团队 | 邮箱 | 密码 | 令牌 |
| --- | --- | --- | --- | --- | --- | --- |
| Alice | `u_alice` | 普通用户 | `t_alpha` | `alice@acme.test` | `alice-pw-2026` | `tok_alice` |
| Bob | `u_bob` | 普通用户 | `t_beta` | `bob@acme.test` | `bob-pw-2026` | `tok_bob` |
| Carol | `u_carol` | 管理员 | `t_ops` | `carol@acme.test` | `carol-pw-2026` | `tok_carol` |

令牌放在 `Authorization: Bearer <令牌>` 头里，匿名就是不带这个头。令牌也可以用 `POST /api/auth/login`
（请求体 `{"email": …, "password": …}`）换出来；本地测试直接用上表的令牌就行。

## 种子数据的 id

每个普通用户名下有自己的一份数据，Alice 的以 `_alpha` 结尾、Bob 的以 `_beta` 结尾：

- 团队：`t_alpha`（Alice）、`t_beta`（Bob）、`t_ops`（Carol）
- 项目：`p_alpha`（Alice）、`p_beta`（Bob）
- 任务：`tsk_alpha`（在 `p_alpha`）、`tsk_beta`（在 `p_beta`）
- 文件：`f_alpha`、`f_beta`
- 发票：`inv_alpha`、`inv_beta`
- 便签：`n_alpha`、`n_beta`
- 报表：`r_alpha`、`r_beta`
- Webhook：`wh_alpha`、`wh_beta`
- 内部发布稿：`pub_alpha`
- 功能开关：`beta_checkout`、`new_dashboard`
