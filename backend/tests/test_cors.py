import pathlib
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings, settings
from app.core.cors import DEFAULT_CORS_ORIGINS, add_cors, parse_cors_origins
from app.core.body_limit import BODY_OVERHEAD_ALLOWANCE
from app.main import app as real_app

ALLOWED = "http://localhost:3000"


def make_app(origins):
    small = FastAPI()
    add_cors(small, origins)

    @small.get("/ping")
    def ping():
        return {"ok": True}

    @small.post("/ping")
    def ping_post():
        return {"ok": True}

    return TestClient(small)


class ParseTests(unittest.TestCase):
    def test_default_matches_previous_hardcoded_behavior(self):
        self.assertEqual(parse_cors_origins(DEFAULT_CORS_ORIGINS), ["http://localhost:3000", "http://localhost:3001"])

    def test_single_origin(self):
        self.assertEqual(parse_cors_origins("https://app.example.com"), ["https://app.example.com"])

    def test_multiple_origins(self):
        self.assertEqual(
            parse_cors_origins("http://localhost:3000,http://127.0.0.1:3000,https://app.example.com"),
            ["http://localhost:3000", "http://127.0.0.1:3000", "https://app.example.com"],
        )

    def test_whitespace_trailing_comma_and_empty_items_tolerated(self):
        self.assertEqual(
            parse_cors_origins("  http://localhost:3000 ,\thttps://app.example.com  ,, "),
            ["http://localhost:3000", "https://app.example.com"],
        )

    def test_trailing_slashes_are_normalized(self):
        self.assertEqual(parse_cors_origins("https://app.example.com/,http://localhost:3000//"),
                         ["https://app.example.com", "http://localhost:3000"])

    def test_case_is_normalized_and_duplicates_dropped(self):
        self.assertEqual(parse_cors_origins("HTTPS://App.Example.com,https://app.example.com/"), ["https://app.example.com"])

    def test_ipv6_and_ports(self):
        self.assertEqual(parse_cors_origins("http://[::1]:3000"), ["http://[::1]:3000"])

    def test_empty_configuration_fails_clearly(self):
        for raw in ("", "   ", " , ,", None):
            with self.assertRaises(ValueError, msg=repr(raw)) as ctx:
                parse_cors_origins(raw)
            self.assertIn("at least one origin", str(ctx.exception))

    def test_wildcards_rejected_never_converted_to_allow_all(self):
        for raw in ("*", "http://localhost:3000,*", "https://*.example.com", "http://*"):
            with self.assertRaises(ValueError, msg=raw) as ctx:
                parse_cors_origins(raw)
            self.assertIn("wildcard", str(ctx.exception))

    def test_malformed_origins_rejected(self):
        for raw in ("localhost:3000", "ftp://example.com", "http://example.com/path", "https://app.example.com?x=1",
                    "http://", "null", "http://exa mple.com", "http://localhost:99999", "http://localhost:0",
                    "http://user@example.com", "javascript:alert(1)"):
            with self.assertRaises(ValueError, msg=raw):
                parse_cors_origins(raw)

    def test_one_bad_entry_fails_the_whole_list(self):
        with self.assertRaises(ValueError):
            parse_cors_origins("http://localhost:3000,not-an-origin")


class SettingsTests(unittest.TestCase):
    def test_default_setting(self):
        self.assertEqual(Settings.model_fields["CORS_ORIGINS"].default, DEFAULT_CORS_ORIGINS)
        self.assertEqual(settings.cors_origins, ["http://localhost:3000", "http://localhost:3001"])

    def test_settings_parse_env_value(self):
        s = Settings(SECRET_KEY="x", DATABASE_URL="sqlite://", CORS_ORIGINS=" https://a.example.com/ , http://localhost:3000 ")
        self.assertEqual(s.cors_origins, ["https://a.example.com", "http://localhost:3000"])

    def test_invalid_setting_stops_startup(self):
        for raw in ("*", "", "not-an-origin"):
            with self.assertRaises(ValidationError, msg=repr(raw)):
                Settings(SECRET_KEY="x", DATABASE_URL="sqlite://", CORS_ORIGINS=raw)

    def test_env_var_is_read(self):
        with patch.dict("os.environ", {"CORS_ORIGINS": "https://env.example.com"}):
            s = Settings(SECRET_KEY="x", DATABASE_URL="sqlite://")
        self.assertEqual(s.cors_origins, ["https://env.example.com"])

    def test_env_example_documents_setting_without_production_domains(self):
        text = (pathlib.Path(__file__).resolve().parents[1] / ".env.example").read_text()
        self.assertIn("CORS_ORIGINS=http://localhost:3000,http://localhost:3001", text)
        self.assertNotIn("example.com\n", text.split("CORS_ORIGINS=http://localhost:3000,http://localhost:3001")[1])


# NOTE on credentials: Starlette adds "Access-Control-Allow-Credentials: true" to every response to a request carrying an
# Origin header when allow_credentials=True, even for non-allowed origins. Browsers only honor it together with a matching
# Access-Control-Allow-Origin, which is never sent for non-allowed origins, so these tests assert on that header.
class ConfiguredOriginTests(unittest.TestCase):
    def test_configured_additional_origin_is_allowed(self):
        client = make_app(parse_cors_origins("http://localhost:3000,https://app.example.com"))
        res = client.get("/ping", headers={"Origin": "https://app.example.com"})
        self.assertEqual(res.headers.get("access-control-allow-origin"), "https://app.example.com")
        self.assertEqual(res.headers.get("access-control-allow-credentials"), "true")

    def test_each_of_multiple_origins_is_allowed_and_echoed_individually(self):
        origins = ["http://localhost:3000", "http://127.0.0.1:3000", "https://app.example.com"]
        client = make_app(origins)
        for origin in origins:
            res = client.get("/ping", headers={"Origin": origin})
            self.assertEqual(res.headers.get("access-control-allow-origin"), origin)  # never a list, never "*"

    def test_unconfigured_origins_get_no_cors_headers(self):
        client = make_app(["https://app.example.com"])
        for origin in ("https://evil.example.org", "http://app.example.com", "https://app.example.com.evil.com",
                       "https://sub.app.example.com", "https://app.example.com:8443", "null"):
            res = client.get("/ping", headers={"Origin": origin})
            self.assertEqual(res.status_code, 200)
            self.assertNotIn("access-control-allow-origin", res.headers, origin)

    def test_trailing_slash_in_config_matches_real_browser_origin(self):
        client = make_app(parse_cors_origins("https://app.example.com/"))
        res = client.get("/ping", headers={"Origin": "https://app.example.com"})
        self.assertEqual(res.headers.get("access-control-allow-origin"), "https://app.example.com")

    def test_preflight_for_configured_origin(self):
        client = make_app(["https://app.example.com"])
        res = client.options("/ping", headers={
            "Origin": "https://app.example.com", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-custom"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["access-control-allow-origin"], "https://app.example.com")
        self.assertEqual(res.headers["access-control-allow-credentials"], "true")
        self.assertIn("POST", res.headers["access-control-allow-methods"])
        self.assertIn("content-type", res.headers["access-control-allow-headers"].lower())

    def test_preflight_for_unconfigured_origin_is_refused(self):
        client = make_app(["https://app.example.com"])
        res = client.options("/ping", headers={"Origin": "https://evil.example.org", "Access-Control-Request-Method": "POST"})
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("access-control-allow-origin", res.headers)

    def test_request_without_origin_has_no_cors_headers(self):
        res = make_app(["https://app.example.com"]).get("/ping")
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("access-control-allow-origin", res.headers)


class RealAppTests(unittest.TestCase):
    """The actual application, with the default (development) configuration."""

    def setUp(self):
        from app.database.database import Base, engine
        from app.database.init_db import init_db
        Base.metadata.drop_all(bind=engine)
        init_db()
        self.client = TestClient(real_app)

    def test_localhost_3000_and_3001_allowed_with_credentials(self):
        for origin in ("http://localhost:3000", "http://localhost:3001"):
            res = self.client.get("/health", headers={"Origin": origin})
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers["access-control-allow-origin"], origin)
            self.assertEqual(res.headers["access-control-allow-credentials"], "true")

    def test_no_wildcard_is_ever_returned(self):
        for origin in (ALLOWED, "https://evil.example.org", "null"):
            res = self.client.get("/health", headers={"Origin": origin})
            self.assertNotEqual(res.headers.get("access-control-allow-origin"), "*")
        pre = self.client.options("/auth/login", headers={"Origin": ALLOWED, "Access-Control-Request-Method": "POST"})
        self.assertNotEqual(pre.headers.get("access-control-allow-origin"), "*")
        self.assertNotIn("*", settings.cors_origins)

    def test_unallowed_origin_rejected(self):
        for origin in ("https://evil.example.org", "http://127.0.0.1:3000", "http://localhost:4000", "https://localhost:3000"):
            res = self.client.get("/health", headers={"Origin": origin})
            self.assertNotIn("access-control-allow-origin", res.headers, origin)

    def test_preflight_options_for_login(self):
        res = self.client.options("/auth/login", headers={
            "Origin": ALLOWED, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["access-control-allow-origin"], ALLOWED)
        self.assertEqual(res.headers["access-control-allow-credentials"], "true")
        bad = self.client.options("/auth/login", headers={"Origin": "https://evil.example.org", "Access-Control-Request-Method": "POST"})
        self.assertEqual(bad.status_code, 400)
        self.assertNotIn("access-control-allow-origin", bad.headers)

    def test_credentialed_post_from_allowed_origin_gets_cookie_and_cors_headers(self):
        res = self.client.post("/auth/login", data={"username": "nobody@example.com", "password": "x"}, headers={"Origin": ALLOWED})
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.headers["access-control-allow-origin"], ALLOWED)
        self.assertEqual(res.headers["access-control-allow-credentials"], "true")

    def test_upload_413_keeps_cors_headers_for_allowed_origin_only(self):
        body = b"w" * (int(settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024) + BODY_OVERHEAD_ALLOWANCE + 1000)
        ok = self.client.post("/upload", files={"file": ("huge.txt", body)}, headers={"Origin": ALLOWED})
        self.assertEqual(ok.status_code, 413)
        self.assertEqual(ok.headers["access-control-allow-origin"], ALLOWED)
        self.assertEqual(ok.headers["access-control-allow-credentials"], "true")
        bad = self.client.post("/upload", files={"file": ("huge.txt", body)}, headers={"Origin": "https://evil.example.org"})
        self.assertEqual(bad.status_code, 413)
        self.assertNotIn("access-control-allow-origin", bad.headers)

    def test_source_has_no_hardcoded_origins_or_wildcard(self):
        main_src = (pathlib.Path(__file__).resolve().parents[1] / "app" / "main.py").read_text()
        self.assertNotIn("localhost:3000", main_src)
        self.assertNotIn('allow_origins=["*"]', main_src)
        self.assertIn("settings.cors_origins", main_src)


if __name__ == "__main__":
    unittest.main()
