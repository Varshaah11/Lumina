"""
Cross-user authorization over HTTP for the routes that take a resource id from the client: chat_id on upload,
document_id on chat streaming, and the profile. Chat-ownership checks on GET/PATCH/DELETE/regenerate/stream themselves
live in tests/test_chat_routes.py and are not repeated here.

User A is always the attacker, user B the victim. Real routes and real auth (Bearer tokens) are used; only the
embedding and LLM layers are deterministic fakes.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import app.services.chat_service as chat_service_module
from app.ai.client import ollama_client
from app.ai.service import ai_service
from app.auth.jwt import create_access_token
from app.main import app
from app.models.chat import Chat
from app.models.document import Document, chat_documents
from app.models.message import Message
from app.models.user import User

B_SECRET = "Victim quarterly revenue figures are confidential and secret."
A_TEXT = "Attacker notes about gardening tomatoes and growing herbs at home."


def auth(user) -> dict:
    return {"Authorization": f"Bearer {create_access_token({'sub': user.email})}"}


def links(db_session) -> set[tuple[int, int]]:
    """(chat_id, document_id) pairs."""
    db_session.expire_all()
    return {(r.chat_id, r.document_id) for r in db_session.execute(select(chat_documents)).all()}


@pytest.fixture(autouse=True)
def fake_embeddings():
    async def batch(texts, model=None):
        return [[1.0, 0.0, 0.0] for _ in texts]

    async def one(text, model=None):
        return [1.0, 0.0, 0.0]

    with patch.object(ollama_client, "get_embeddings_batch", side_effect=batch), \
         patch.object(ollama_client, "get_embedding", side_effect=one):
        yield


@pytest.fixture
def fake_ai():
    calls = []

    async def stream(**kwargs):
        calls.append(kwargs)
        yield f"data: {json.dumps({'token': 'ok'})}\n\n"

    with patch.object(ai_service, "stream_chat_response", new=stream), \
         patch.object(chat_service_module, "schedule_title_generation", new=MagicMock()):
        yield calls


@pytest.fixture
def client(db_session):
    """Non-raising client: authorization failures must be answered, not surface as test exceptions."""
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture
def world(db_session, make_user, client):
    """Attacker A with a chat; victim B with a chat that has an uploaded document attached."""
    a, b = make_user(name="Attacker A"), make_user(name="Victim B")
    chat_a, chat_b = Chat(title="A chat", user_id=a.id), Chat(title="B chat", user_id=b.id)
    db_session.add_all([chat_a, chat_b])
    db_session.commit()
    res = client.post("/upload", headers=auth(b), data={"chat_id": str(chat_b.id)},
                      files={"file": ("b-secret.txt", (B_SECRET + " ") * 3)})
    assert res.status_code == 200
    return a, b, chat_a.id, chat_b.id, res.json()["id"]


def upload(client, user, text, chat_id=None, name="notes.txt"):
    data = {"chat_id": str(chat_id)} if chat_id is not None else {}
    return client.post("/upload", headers=auth(user), data=data, files={"file": (name, (text + " ") * 3)})


# ---------------------------------------------------------------- upload: chat association
def test_upload_into_own_chat_links_the_document(client, db_session, world):
    a, _, chat_a, _, _ = world
    res = upload(client, a, A_TEXT, chat_id=chat_a)
    assert res.status_code == 200
    assert (chat_a, res.json()["id"]) in links(db_session)


def test_upload_requires_authentication_even_with_a_chat_id(client, db_session, world):
    _, _, _, chat_b, _ = world
    before = links(db_session)
    res = client.post("/upload", data={"chat_id": str(chat_b)}, files={"file": ("x.txt", A_TEXT * 3)})
    assert res.status_code == 401
    assert links(db_session) == before


@pytest.mark.xfail(strict=True, reason="KNOWN BUG: POST /upload links the new document to any existing chat_id without "
                                       "checking that the chat belongs to the caller")
def test_upload_with_another_users_chat_id_is_rejected_without_linking(client, db_session, world):
    a, _, _, chat_b, _ = world
    before = links(db_session)
    docs_before = db_session.query(Document).filter(Document.user_id == a.id).count()

    res = upload(client, a, A_TEXT, chat_id=chat_b)

    assert res.status_code in (403, 404)
    assert links(db_session) == before
    assert not any(chat == chat_b for chat, _ in links(db_session) - before)
    assert db_session.query(Document).filter(Document.user_id == a.id).count() == docs_before


@pytest.mark.xfail(strict=True, reason="KNOWN BUG: a duplicate (already stored) document is also re-linked to another "
                                       "user's chat_id without an ownership check")
def test_reupload_of_an_existing_document_into_another_users_chat_is_rejected(client, db_session, world):
    a, _, chat_a, chat_b, _ = world
    doc_id = upload(client, a, A_TEXT, chat_id=chat_a).json()["id"]

    res = upload(client, a, A_TEXT, chat_id=chat_b)

    assert res.status_code in (403, 404)
    assert (chat_b, doc_id) not in links(db_session)


@pytest.mark.xfail(strict=True, reason="KNOWN BUG: an unknown chat_id on POST /upload fails the foreign key and returns 500, "
                                       "while another user's chat returns 200, so the route reveals which chat ids exist")
def test_upload_with_a_nonexistent_chat_id_is_a_404_like_another_users_chat(client, db_session, world):
    a, _, _, _, _ = world
    res = upload(client, a, A_TEXT, chat_id=987654)
    assert res.status_code == 404


def test_cross_user_link_never_exposes_the_attackers_document_to_the_victims_retrieval(client, db_session, fake_ai, world):
    """Defence in depth that holds today even though the upload route accepts the foreign chat_id."""
    a, b, _, chat_b, _ = world
    upload(client, a, A_TEXT, chat_id=chat_b)
    client.post("/chat/stream", headers=auth(b), json={"message": "Summarise the document about tomatoes", "chat_id": chat_b})
    prompt = json.dumps(fake_ai[-1]["messages_history"])
    assert "gardening tomatoes" not in prompt


def test_victim_document_is_not_exposed_to_the_attacker_through_the_victims_chat_id(client, db_session, fake_ai, world):
    a, _, _, chat_b, _ = world
    res = client.post("/chat/stream", headers=auth(a), json={"message": "Summarise the document", "chat_id": chat_b})
    assert B_SECRET not in res.text
    assert fake_ai == []


# ---------------------------------------------------------------- chat streaming: document_id
def test_streaming_with_another_users_document_id_neither_links_nor_leaks_it(client, db_session, fake_ai, world):
    a, _, chat_a, _, doc_b = world
    res = client.post("/chat/stream", headers=auth(a),
                      json={"message": "Summarise this document for me", "chat_id": chat_a, "document_id": doc_b})
    assert res.status_code == 200
    assert (chat_a, doc_b) not in links(db_session)
    sent_to_model = json.dumps(fake_ai[-1]["messages_history"])
    assert "Victim quarterly revenue" not in sent_to_model
    assert fake_ai[-1]["has_document"] is False
    assert "Victim quarterly revenue" not in res.text


def test_streaming_a_new_chat_with_another_users_document_id_does_not_link_it(client, db_session, fake_ai, world):
    a, _, _, _, doc_b = world
    res = client.post("/chat/stream", headers=auth(a), json={"message": "Summarise this document", "document_id": doc_b})
    new_chat = json.loads(res.text.split("\n\n")[0][len("data: "):])["chat_id"]
    assert not any(chat == new_chat for chat, _ in links(db_session))
    assert "Victim quarterly revenue" not in json.dumps(fake_ai[-1]["messages_history"])


def test_own_document_id_is_linked_and_used(client, db_session, fake_ai, world):
    """Positive control for the two tests above: the same request with the caller's own document works."""
    a, _, chat_a, _, _ = world
    doc_a = upload(client, a, A_TEXT).json()["id"]
    client.post("/chat/stream", headers=auth(a),
                json={"message": "Summarise this document about tomatoes", "chat_id": chat_a, "document_id": doc_a})
    assert (chat_a, doc_a) in links(db_session)
    assert fake_ai[-1]["has_document"] is True


def test_identical_bytes_uploaded_by_two_users_stay_separate_documents(client, db_session, world):
    a, b, _, _, doc_b = world
    res = client.post("/upload", headers=auth(a), files={"file": ("copy.txt", (B_SECRET + " ") * 3)})
    assert res.status_code == 200
    assert res.json()["id"] != doc_b
    db_session.expire_all()
    assert db_session.get(Document, doc_b).user_id == b.id


def test_deleting_own_chat_never_deletes_another_users_document(client, db_session, world):
    a, b, chat_a, _, doc_b = world
    assert client.delete(f"/chat/{chat_a}", headers=auth(a)).status_code == 200
    db_session.expire_all()
    assert db_session.get(Document, doc_b) is not None


# ---------------------------------------------------------------- history isolation
def test_chat_history_never_contains_another_users_messages(client, db_session, world):
    a, b, chat_a, chat_b, _ = world
    db_session.add_all([Message(chat_id=chat_a, role="user", content="A message"),
                        Message(chat_id=chat_b, role="user", content="B private message")])
    db_session.commit()
    body = client.get(f"/chat/{chat_a}", headers=auth(a)).text
    assert "A message" in body and "B private message" not in body
    assert "B chat" not in client.get("/chat/", headers=auth(a)).text


# ---------------------------------------------------------------- profile: identity comes only from the token
def test_profile_update_cannot_target_or_take_over_another_account(client, db_session, world):
    a, b, _, _, _ = world
    res = client.patch("/auth/profile", headers=auth(a), json={
        "id": b.id, "user_id": b.id, "email": b.email, "hashed_password": "attacker", "name": "A renamed",
    })
    assert res.status_code == 200
    assert res.json()["id"] == a.id and res.json()["email"] == a.email and res.json()["name"] == "A renamed"

    db_session.expire_all()
    victim = db_session.get(User, b.id)
    attacker = db_session.get(User, a.id)
    assert victim.name == "Victim B" and victim.email == b.email
    assert attacker.email == a.email and attacker.hashed_password != "attacker"


def test_profile_read_ignores_identity_hints_in_the_query_string(client, world):
    a, b, _, _, _ = world
    res = client.get(f"/auth/profile?id={b.id}&email={b.email}", headers=auth(a))
    assert res.status_code == 200
    assert res.json()["id"] == a.id
