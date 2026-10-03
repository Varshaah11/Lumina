"""
Global error handling (app/core/exceptions.py as wired in app/main.py): unknown routes, request-validation errors,
application HTTPExceptions and unexpected exceptions. The contract is the response the client sees: status code,
a JSON `detail`, and nothing internal (exception text, class names, SQL, file paths, submitted values).
Only response bodies and headers are asserted; log output is not.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.auth.jwt import create_access_token
from app.main import app
from app.services.chat_service import chat_service

SECRET_MARKER = "INTERNAL-DETAIL-/srv/lumina/secret.db-password=hunter2"


@pytest.fixture
def client(db_session):
    """Like the real server: unhandled errors become responses instead of being re-raised into the test."""
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture
def headers(make_user):
    user = make_user(name="Error Handling User")
    return {"Authorization": f"Bearer {create_access_token({'sub': user.email})}"}


def assert_no_internals(res):
    text = res.text
    for leak in (SECRET_MARKER, "Traceback", "RuntimeError", "OverflowError", "sqlalchemy", 'File "', ".py"):
        assert leak not in text


# ---------------------------------------------------------------- 404 / 405
@pytest.mark.parametrize("path", ["/does-not-exist", "/chat/1/unknown", "/auth/../../etc/passwd", "/upload/extra/segments"])
def test_unknown_route_is_a_json_404(client, path):
    res = client.get(path)
    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/json")
    assert res.json() == {"detail": "Not Found"}


def test_wrong_method_is_a_json_405(client):
    res = client.put("/chat/", json={})
    assert res.status_code == 405
    assert res.json() == {"detail": "Method Not Allowed"}
    assert "GET" in res.headers.get("allow", "")


# ---------------------------------------------------------------- 422 shape
def test_validation_error_shape_is_a_list_of_loc_msg_type(client, headers):
    res = client.post("/chat/stream", headers=headers, json={"message": "", "chat_id": "abc"})
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert isinstance(detail, list) and len(detail) == 2
    for err in detail:
        assert set(err) == {"loc", "msg", "type"}
        assert isinstance(err["loc"], list) and err["loc"][0] == "body"
        assert isinstance(err["msg"], str) and err["msg"]
    assert {tuple(e["loc"]) for e in detail} == {("body", "message"), ("body", "chat_id")}


def test_validation_error_never_echoes_submitted_values(client, headers):
    res = client.patch("/chat/1", headers=headers, json={"title": SECRET_MARKER * 10})
    assert res.status_code == 422
    assert SECRET_MARKER not in res.text
    assert "input" not in res.json()["detail"][0] and "ctx" not in res.json()["detail"][0]


def test_value_error_prefix_is_stripped_from_custom_validator_messages(client):
    res = client.post("/auth/register", json={"name": "N", "email": "v@example.com", "password": "é" * 40})
    assert res.status_code == 422
    assert all(not e["msg"].startswith("Value error") for e in res.json()["detail"])


def test_malformed_json_is_a_422_without_echoing_the_body(client, headers):
    res = client.post("/chat/stream", headers={**headers, "Content-Type": "application/json"},
                      content=f'{{"message": "{SECRET_MARKER}"'.encode())
    assert res.status_code == 422
    assert res.json()["detail"][0]["type"] == "json_invalid"
    assert SECRET_MARKER not in res.text


@pytest.mark.parametrize("path", ["/chat/abc", "/chat/1e3"])
def test_path_parameter_errors_use_the_same_shape(client, headers, path):
    res = client.get(path, headers=headers)
    assert res.status_code == 422
    assert set(res.json()["detail"][0]) == {"loc", "msg", "type"}
    assert res.json()["detail"][0]["loc"] == ["path", "chat_id"]


# ---------------------------------------------------------------- application HTTPExceptions
def test_http_exception_keeps_its_status_detail_and_headers(client):
    res = client.get("/auth/me")
    assert res.status_code == 401
    assert res.json() == {"detail": "Could not validate credentials"}
    assert res.headers["www-authenticate"] == "Bearer"


def test_service_value_error_is_translated_to_a_400_with_the_safe_message(client, headers):
    res = client.patch("/chat/1", headers=headers, json={"title": "   "})
    assert res.status_code == 400
    assert res.json() == {"detail": "Title cannot be empty or whitespace-only"}


def test_document_errors_return_a_stable_message_not_the_parser_error(client, headers):
    res = client.post("/upload", headers=headers, files={"file": ("empty.txt", b"   \n\t  ")})
    assert 400 <= res.status_code < 500
    assert set(res.json()) == {"detail"}
    assert_no_internals(res)


# ---------------------------------------------------------------- unexpected exceptions
@pytest.mark.parametrize("target, method, path", [
    ("get_user_chats", "get", "/chat/"),
    ("get_chat_history", "get", "/chat/1"),
    ("delete_chat", "delete", "/chat/1"),
    ("rename_chat", "patch", "/chat/1"),
])
def test_unexpected_exception_is_a_generic_500(client, headers, target, method, path):
    kwargs = {"json": {"title": "New title"}} if method == "patch" else {}
    with patch.object(chat_service, target, side_effect=RuntimeError(SECRET_MARKER)):
        res = getattr(client, method)(path, headers=headers, **kwargs)
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal server error"}
    assert_no_internals(res)


def test_failure_inside_a_dependency_is_a_generic_500(client, headers):
    def broken_db():
        raise RuntimeError(SECRET_MARKER)
        yield  # pragma: no cover

    app.dependency_overrides[get_db] = broken_db
    res = client.get("/chat/", headers=headers)
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal server error"}
    assert_no_internals(res)


def test_database_error_is_a_generic_500(client, headers):
    from sqlalchemy.exc import OperationalError
    with patch.object(chat_service, "get_user_chats",
                      side_effect=OperationalError("SELECT * FROM chats", {}, Exception(SECRET_MARKER))):
        res = client.get("/chat/", headers=headers)
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal server error"}
    assert "SELECT" not in res.text
    assert_no_internals(res)


def test_server_keeps_serving_after_an_unhandled_error(client, headers):
    with patch.object(chat_service, "get_user_chats", side_effect=RuntimeError(SECRET_MARKER)):
        assert client.get("/chat/", headers=headers).status_code == 500
    assert client.get("/chat/", headers=headers).status_code == 200
