"""
HTTP-level tests for the chat routes: GET /chat/, GET/PATCH/DELETE /chat/{id}, POST /chat/stream and
POST /chat/{id}/regenerate. Authentication, ownership, request validation, SSE framing and the persisted side effects.

The AI layer is replaced by a deterministic fake stream (no Ollama) and background title generation is stubbed out.
Current ownership contract (inspected in app/api/routes/chat.py and chat_service): JSON routes answer 404 "Chat not
found" for a chat the caller does not own (no 403, so existence is not revealed); the SSE routes always answer 200 and
report the problem as a single `error` event.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import app.services.chat_service as chat_service_module
from app.ai.service import ai_service
from app.auth.jwt import create_access_token
from app.core.config import settings
from app.main import app
from app.models.chat import Chat
from app.models.message import Message

TOKENS = ["Hello", " from", " Lumina"]


def auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token({'sub': user.email})}"}


def sse_frames(body: str) -> list[str]:
    """Raw SSE frames (without the terminating blank line)."""
    return [frame for frame in body.split("\n\n") if frame.strip()]


def sse_events(body: str) -> list[dict]:
    return [json.loads(frame[len("data: "):]) for frame in sse_frames(body)]


class FakeAI:
    """Records every stream_chat_response call and replays `tokens` as SSE token events."""

    def __init__(self):
        self.calls: list[dict] = []
        self.tokens = list(TOKENS)
        self.extra_events: list[dict] = []

    async def stream(self, **kwargs):
        self.calls.append(kwargs)
        for token in self.tokens:
            yield f"data: {json.dumps({'token': token})}\n\n"
        for event in self.extra_events:
            yield f"data: {json.dumps(event)}\n\n"


@pytest.fixture
def fake_ai():
    fake = FakeAI()
    with patch.object(ai_service, "stream_chat_response", new=fake.stream), \
         patch.object(chat_service_module, "schedule_title_generation", new=MagicMock()) as titles:
        fake.schedule_title = titles
        yield fake


@pytest.fixture
def owner(make_user):
    return make_user(name="Chat Owner")


@pytest.fixture
def intruder(make_user):
    return make_user(name="Chat Intruder")


@pytest.fixture
def make_chat(db_session):
    def _make(user, title="A chat", messages=()):
        chat = Chat(title=title, user_id=user.id)
        db_session.add(chat)
        db_session.commit()
        for role, content in messages:
            db_session.add(Message(chat_id=chat.id, role=role, content=content))
        db_session.commit()
        return chat
    return _make


@pytest.fixture
def safe_client(db_session):
    """Client that returns 500 responses instead of re-raising server errors."""
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def messages_of(db_session, chat_id) -> list[tuple[str, str]]:
    db_session.expire_all()
    rows = db_session.query(Message).filter(Message.chat_id == chat_id).order_by(Message.id).all()
    return [(m.role, m.content) for m in rows]


# ---------------------------------------------------------------- authentication
@pytest.mark.parametrize("method, path, body", [
    ("get", "/chat/", None),
    ("get", "/chat/1", None),
    ("patch", "/chat/1", {"title": "New"}),
    ("delete", "/chat/1", None),
    ("post", "/chat/stream", {"message": "hello"}),
    ("post", "/chat/1/regenerate", None),
])
def test_every_chat_route_rejects_unauthenticated_requests(api_client, fake_ai, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    res = getattr(api_client, method)(path, **kwargs)
    assert res.status_code == 401
    assert fake_ai.calls == []


def test_owner_can_list_and_read_their_chat_with_the_session_cookie(api_client, owner, make_chat):
    chat = make_chat(owner, title="Cookie chat", messages=[("user", "Hi"), ("assistant", "Hello!")])
    api_client.cookies.set(settings.AUTH_COOKIE_NAME, create_access_token({"sub": owner.email}))

    listed = api_client.get("/chat/")
    assert listed.status_code == 200
    assert [c["id"] for c in listed.json()] == [chat.id]
    assert listed.json()[0]["title"] == "Cookie chat"

    history = api_client.get(f"/chat/{chat.id}")
    assert history.status_code == 200
    body = history.json()
    assert body["id"] == chat.id
    assert [(m["role"], m["content"]) for m in body["messages"]] == [("user", "Hi"), ("assistant", "Hello!")]


def test_chat_list_is_empty_for_a_new_user(api_client, owner):
    res = api_client.get("/chat/", headers=auth(owner))
    assert res.status_code == 200
    assert res.json() == []


# ---------------------------------------------------------------- ownership (404 for JSON routes, error event for SSE)
def test_user_cannot_read_another_users_chat(api_client, owner, intruder, make_chat):
    chat = make_chat(owner, messages=[("user", "private question")])
    res = api_client.get(f"/chat/{chat.id}", headers=auth(intruder))
    assert res.status_code == 404
    assert "private question" not in res.text


def test_user_cannot_rename_another_users_chat(api_client, db_session, owner, intruder, make_chat):
    chat = make_chat(owner, title="Original")
    res = api_client.patch(f"/chat/{chat.id}", json={"title": "Hijacked"}, headers=auth(intruder))
    assert res.status_code == 404
    db_session.expire_all()
    assert db_session.get(Chat, chat.id).title == "Original"


def test_user_cannot_delete_another_users_chat(api_client, db_session, owner, intruder, make_chat):
    chat = make_chat(owner, messages=[("user", "keep me")])
    res = api_client.delete(f"/chat/{chat.id}", headers=auth(intruder))
    assert res.status_code == 404
    db_session.expire_all()
    assert db_session.get(Chat, chat.id) is not None
    assert messages_of(db_session, chat.id) == [("user", "keep me")]


def test_user_cannot_regenerate_another_users_chat(api_client, db_session, fake_ai, owner, intruder, make_chat):
    chat = make_chat(owner, messages=[("user", "question"), ("assistant", "original answer")])
    res = api_client.post(f"/chat/{chat.id}/regenerate", headers=auth(intruder))
    assert res.status_code == 200
    assert sse_events(res.text) == [{"error": "Chat not found"}]
    assert fake_ai.calls == []
    assert messages_of(db_session, chat.id) == [("user", "question"), ("assistant", "original answer")]


def test_user_cannot_post_into_another_users_chat(api_client, db_session, fake_ai, owner, intruder, make_chat):
    chat = make_chat(owner, messages=[("user", "question")])
    res = api_client.post("/chat/stream", json={"message": "injected", "chat_id": chat.id}, headers=auth(intruder))
    assert res.status_code == 200
    assert sse_events(res.text) == [{"error": "Chat not found"}]
    assert fake_ai.calls == []
    assert messages_of(db_session, chat.id) == [("user", "question")]


def test_chat_list_contains_only_the_callers_chats(api_client, owner, intruder, make_chat):
    mine = make_chat(owner, title="Mine")
    make_chat(intruder, title="Theirs")
    res = api_client.get("/chat/", headers=auth(owner))
    assert [c["id"] for c in res.json()] == [mine.id]


# ---------------------------------------------------------------- id and payload validation
@pytest.mark.parametrize("method, path", [
    ("get", "/chat/abc"),
    ("patch", "/chat/abc"),
    ("delete", "/chat/1.5"),
    ("post", "/chat/abc/regenerate"),
])
def test_non_integer_chat_id_is_a_422(api_client, owner, method, path):
    kwargs = {"json": {"title": "x"}} if method == "patch" else {}
    res = getattr(api_client, method)(path, headers=auth(owner), **kwargs)
    assert res.status_code == 422
    assert res.json()["detail"][0]["loc"][:2] == ["path", "chat_id"]


@pytest.mark.parametrize("chat_id", [0, -1, 987654])
def test_unknown_chat_id_is_a_404(api_client, owner, chat_id):
    headers = auth(owner)
    assert api_client.get(f"/chat/{chat_id}", headers=headers).status_code == 404
    assert api_client.patch(f"/chat/{chat_id}", json={"title": "x"}, headers=headers).status_code == 404
    assert api_client.delete(f"/chat/{chat_id}", headers=headers).status_code == 404


@pytest.mark.xfail(strict=True, reason="KNOWN BUG: ids outside SQLite's 64-bit INTEGER range raise OverflowError -> 500")
@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_chat_id_beyond_64_bit_range_is_not_a_server_error(safe_client, owner, method):
    kwargs = {"json": {"title": "x"}} if method == "patch" else {}
    res = getattr(safe_client, method)(f"/chat/{2 ** 63}", headers=auth(owner), **kwargs)
    assert res.status_code in (404, 422)


@pytest.mark.parametrize("payload", [
    {},                               # missing message
    {"message": ""},                  # min_length=1
    {"message": None},
    {"message": 123},
    {"message": ["hello"]},
    {"message": "hi", "chat_id": "abc"},
    {"message": "hi", "document_id": "abc"},
    {"message": "hi", "is_voice": "sometimes"},
])
def test_invalid_stream_payloads_are_rejected_before_any_work(api_client, db_session, fake_ai, owner, payload):
    res = api_client.post("/chat/stream", json=payload, headers=auth(owner))
    assert res.status_code == 422
    assert isinstance(res.json()["detail"], list) and res.json()["detail"]
    assert fake_ai.calls == []
    assert db_session.query(Chat).count() == 0


@pytest.mark.parametrize("raw", [b"{not json", b"", b"[]", b'"just a string"'])
def test_malformed_stream_body_is_a_422(api_client, fake_ai, owner, raw):
    res = api_client.post("/chat/stream", content=raw,
                          headers={**auth(owner), "Content-Type": "application/json"})
    assert res.status_code == 422
    assert fake_ai.calls == []


@pytest.mark.parametrize("payload", [
    {},
    {"title": ""},
    {"title": None},
    {"title": 42},
    {"title": "x" * 256},
])
def test_invalid_rename_payloads_are_a_422_and_change_nothing(api_client, db_session, owner, make_chat, payload):
    chat = make_chat(owner, title="Original")
    res = api_client.patch(f"/chat/{chat.id}", json=payload, headers=auth(owner))
    assert res.status_code == 422
    db_session.expire_all()
    assert db_session.get(Chat, chat.id).title == "Original"


def test_whitespace_only_rename_is_a_400(api_client, db_session, owner, make_chat):
    chat = make_chat(owner, title="Original")
    res = api_client.patch(f"/chat/{chat.id}", json={"title": "   "}, headers=auth(owner))
    assert res.status_code == 400
    db_session.expire_all()
    assert db_session.get(Chat, chat.id).title == "Original"


def test_rename_trims_persists_and_returns_the_chat(api_client, db_session, owner, make_chat):
    chat = make_chat(owner, title="Original")
    res = api_client.patch(f"/chat/{chat.id}", json={"title": "  Renamed chat  "}, headers=auth(owner))
    assert res.status_code == 200
    assert res.json()["id"] == chat.id and res.json()["title"] == "Renamed chat"
    assert api_client.get(f"/chat/{chat.id}", headers=auth(owner)).json()["title"] == "Renamed chat"


def test_rename_accepts_the_maximum_title_length(api_client, owner, make_chat):
    chat = make_chat(owner)
    res = api_client.patch(f"/chat/{chat.id}", json={"title": "t" * 255}, headers=auth(owner))
    assert res.status_code == 200
    assert len(res.json()["title"]) == 255


def test_delete_removes_the_chat_and_its_messages(api_client, db_session, owner, make_chat):
    chat_id = make_chat(owner, messages=[("user", "q"), ("assistant", "a")]).id
    res = api_client.delete(f"/chat/{chat_id}", headers=auth(owner))
    assert res.status_code == 200
    assert res.json()["chat_id"] == chat_id
    assert messages_of(db_session, chat_id) == []
    assert api_client.get(f"/chat/{chat_id}", headers=auth(owner)).status_code == 404
    assert api_client.delete(f"/chat/{chat_id}", headers=auth(owner)).status_code == 404


# ---------------------------------------------------------------- POST /chat/stream
def test_stream_is_server_sent_events_with_well_formed_frames(api_client, fake_ai, owner):
    res = api_client.post("/chat/stream", json={"message": "Hello there"}, headers=auth(owner))
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert res.text.endswith("\n\n")
    frames = sse_frames(res.text)
    assert frames and all(frame.startswith("data: ") and "\n" not in frame for frame in frames)


def test_new_chat_stream_sends_chat_id_first_then_tokens_and_persists_both_turns(api_client, db_session, fake_ai, owner):
    res = api_client.post("/chat/stream", json={"message": "What is Lumina?"}, headers=auth(owner))
    events = sse_events(res.text)

    assert set(events[0]) == {"chat_id"} and isinstance(events[0]["chat_id"], int)
    assert [e["token"] for e in events[1:]] == TOKENS
    chat_id = events[0]["chat_id"]

    db_session.expire_all()
    chat = db_session.get(Chat, chat_id)
    assert chat is not None and chat.user_id == owner.id
    assert messages_of(db_session, chat_id) == [("user", "What is Lumina?"), ("assistant", "".join(TOKENS))]
    fake_ai.schedule_title.assert_called_once()
    assert [c["id"] for c in api_client.get("/chat/", headers=auth(owner)).json()] == [chat_id]


def test_new_chat_title_is_derived_from_the_message(api_client, db_session, fake_ai, owner):
    long_message = "word " * 30
    res = api_client.post("/chat/stream", json={"message": long_message}, headers=auth(owner))
    chat_id = sse_events(res.text)[0]["chat_id"]
    db_session.expire_all()
    title = db_session.get(Chat, chat_id).title
    assert title and len(title) <= 53  # 50 characters plus an ellipsis


def test_stream_into_an_existing_chat_passes_history_and_appends(api_client, db_session, fake_ai, owner, make_chat):
    chat = make_chat(owner, messages=[("user", "First question"), ("assistant", "First answer")])
    res = api_client.post("/chat/stream", json={"message": "Second question", "chat_id": chat.id}, headers=auth(owner))
    events = sse_events(res.text)

    assert events[0] == {"chat_id": chat.id}
    history = fake_ai.calls[0]["messages_history"]
    assert [m["role"] for m in history] == ["user", "assistant", "user"]
    assert history[0]["content"] == "First question" and history[-1]["content"] == "Second question"
    assert messages_of(db_session, chat.id)[-2:] == [("user", "Second question"), ("assistant", "".join(TOKENS))]
    fake_ai.schedule_title.assert_not_called()


def test_stream_into_an_unknown_chat_yields_a_single_error_event(api_client, db_session, fake_ai, owner):
    res = api_client.post("/chat/stream", json={"message": "hi", "chat_id": 424242}, headers=auth(owner))
    assert res.status_code == 200
    assert sse_events(res.text) == [{"error": "Chat not found"}]
    assert fake_ai.calls == []
    assert db_session.query(Chat).count() == 0


@pytest.mark.parametrize("is_voice", [True, False])
def test_voice_flag_is_forwarded_to_the_ai_layer(api_client, fake_ai, owner, is_voice):
    api_client.post("/chat/stream", json={"message": "hello", "is_voice": is_voice}, headers=auth(owner))
    assert fake_ai.calls[0]["is_voice"] is is_voice


def test_deprecated_doc_context_is_never_sent_to_the_model(api_client, fake_ai, owner):
    api_client.post("/chat/stream", json={"message": "Summarise", "doc_context": "CLIENT-SUPPLIED-DOCUMENT-TEXT"},
                    headers=auth(owner))
    prompt = json.dumps(fake_ai.calls[0]["messages_history"])
    assert "CLIENT-SUPPLIED-DOCUMENT-TEXT" not in prompt
    assert fake_ai.calls[0]["has_document"] is False


def test_ai_error_events_are_forwarded_and_no_empty_reply_is_saved(api_client, db_session, fake_ai, owner):
    fake_ai.tokens = []
    fake_ai.extra_events = [{"error": "model unavailable"}]
    res = api_client.post("/chat/stream", json={"message": "hello"}, headers=auth(owner))
    events = sse_events(res.text)
    assert "chat_id" in events[0]
    assert events[-1] == {"error": "model unavailable"}
    assert messages_of(db_session, events[0]["chat_id"]) == [("user", "hello")]
    fake_ai.schedule_title.assert_not_called()


# ---------------------------------------------------------------- POST /chat/{id}/regenerate
def test_regenerate_replaces_the_last_assistant_reply_in_place(api_client, db_session, fake_ai, owner, make_chat):
    chat = make_chat(owner, messages=[
        ("user", "Q1"), ("assistant", "A1"), ("user", "Q2"), ("assistant", "old answer"),
    ])
    res = api_client.post(f"/chat/{chat.id}/regenerate", headers=auth(owner))
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = sse_events(res.text)
    assert events[0] == {"chat_id": chat.id}
    assert [e["token"] for e in events[1:]] == TOKENS

    # History given to the model ends at the user turn being answered and excludes the reply being replaced
    history = fake_ai.calls[0]["messages_history"]
    assert [m["content"] for m in history] == ["Q1", "A1", "Q2"]
    assert messages_of(db_session, chat.id) == [
        ("user", "Q1"), ("assistant", "A1"), ("user", "Q2"), ("assistant", "".join(TOKENS)),
    ]


@pytest.mark.parametrize("body, expected", [(None, False), ({}, False), ({"is_voice": True}, True)])
def test_regenerate_voice_flag(api_client, fake_ai, owner, make_chat, body, expected):
    chat = make_chat(owner, messages=[("user", "Q"), ("assistant", "A")])
    kwargs = {"json": body} if body is not None else {}
    api_client.post(f"/chat/{chat.id}/regenerate", headers=auth(owner), **kwargs)
    assert fake_ai.calls[0]["is_voice"] is expected


def test_regenerate_without_any_reply_tokens_keeps_the_original_answer(api_client, db_session, fake_ai, owner, make_chat):
    chat = make_chat(owner, messages=[("user", "Q"), ("assistant", "original")])
    fake_ai.tokens = []
    api_client.post(f"/chat/{chat.id}/regenerate", headers=auth(owner))
    assert messages_of(db_session, chat.id) == [("user", "Q"), ("assistant", "original")]


@pytest.mark.parametrize("messages, error", [
    ((), "No messages found in chat"),
    ((("user", "only a question"),), "No assistant message found to regenerate"),
])
def test_regenerate_without_an_answer_to_replace_yields_an_error_event(api_client, fake_ai, owner, make_chat, messages, error):
    chat = make_chat(owner, messages=messages)
    res = api_client.post(f"/chat/{chat.id}/regenerate", headers=auth(owner))
    assert res.status_code == 200
    assert sse_events(res.text) == [{"error": error}]
    assert fake_ai.calls == []


@pytest.mark.parametrize("raw", [b"{bad json", b"[]", b'{"is_voice": "maybe"}'])
def test_regenerate_with_an_invalid_body_is_a_422(api_client, fake_ai, owner, make_chat, raw):
    chat = make_chat(owner, messages=[("user", "Q"), ("assistant", "A")])
    res = api_client.post(f"/chat/{chat.id}/regenerate", content=raw,
                          headers={**auth(owner), "Content-Type": "application/json"})
    assert res.status_code == 422
    assert fake_ai.calls == []
