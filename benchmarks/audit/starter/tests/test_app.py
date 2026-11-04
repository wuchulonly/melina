# 冒烟测试：应用能起来、基本的正常流程走得通。只测应当成立的行为。

import unittest

from app import create_app


def auth(actor):
    tok = {"alice": "tok_alice", "bob": "tok_bob", "carol": "tok_carol"}.get(actor)
    return {"Authorization": "Bearer " + tok} if tok else {}


class AppTest(unittest.TestCase):
    def setUp(self):
        self.c = create_app().test_client()

    def test_routes_loaded(self):
        routes = create_app().routes()
        self.assertGreater(len(routes), 40)
        self.assertIn("GET /api/invoices/<invoice_id>", routes)

    def test_login(self):
        r = self.c.post("/api/auth/login", json={"email": "alice@acme.test", "password": "alice-pw-2026"})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.get_json()["token"], "tok_alice")

    def test_login_needs_password(self):
        self.assertEqual(self.c.post("/api/auth/login", json={"email": "alice@acme.test"}).status, 401)
        r = self.c.post("/api/auth/login", json={"email": "alice@acme.test", "password": "nope"})
        self.assertEqual(r.status, 401)

    def test_public_status_is_anonymous(self):
        r = self.c.get("/api/public/status")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.get_json()["status"], "ok")

    def test_owner_reads_own_invoice(self):
        r = self.c.get("/api/invoices/inv_alpha", headers=auth("alice"))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.get_json()["owner"], "u_alice")

    def test_me(self):
        r = self.c.get("/api/auth/me", headers=auth("alice"))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.get_json()["name"], "Alice")

    def test_anonymous_cannot_list_invoices(self):
        r = self.c.get("/api/invoices")
        self.assertEqual(r.status, 401)

    def test_admin_can_read_stats(self):
        r = self.c.get("/api/admin/stats", headers=auth("carol"))
        self.assertEqual(r.status, 200)
        self.assertIn("users", r.get_json())

    def test_owner_lists_only_own_files(self):
        r = self.c.get("/api/files", headers=auth("bob"))
        self.assertEqual(r.status, 200)
        owners = {f["owner"] for f in r.get_json()}
        self.assertEqual(owners, {"u_bob"})


if __name__ == "__main__":
    unittest.main()
