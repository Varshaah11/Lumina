import asyncio
import json
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from app.database.database import SessionLocal, engine, Base
from app.database.init_db import init_db
from app.models.chat import Chat
from app.models.document import Document, chat_documents
from app.models.message import Message
from app.models.user import User
from app.schemas.chat import ChatRequest
from app.services import chat_service as cs
from app.services.rag_service import RAGService, rag_service
from app.ai.prompts import get_system_prompt, CORE_SYSTEM_PROMPT


def sse_tokens(*tokens):
    return [f"data: {json.dumps({'token': t})}\n\n" for t in tokens]


class FakeAI:
    """Replacement for ai_service.stream_chat_response / generate_title."""

    def __init__(self, tokens=("Hello", " ", "world"), hang_after=False, title="AI Title", title_gate=None):
        self.tokens = tokens
        self.hang_after = hang_after
        self.title = title
        self.title_gate = title_gate
        self.calls = []

    async def stream(self, **kwargs):
        self.calls.append(kwargs)
        for chunk in sse_tokens(*self.tokens):
            yield chunk
        if self.hang_after:
            await asyncio.sleep(3600)

    async def generate_title(self, message):
        if self.title_gate is not None:
            await self.title_gate.wait()
        return self.title


def fake_embed_batch(texts, model=None):
    return [[1.0, 0.0, 0.5] for _ in texts]


async def fake_embed_one(text, model=None):
    return [1.0, 0.0, 0.5]


async def fake_embed_batch_async(texts, model=None):
    return fake_embed_batch(texts)


class DBTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        Base.metadata.drop_all(bind=engine)
        init_db()
        self.db = SessionLocal()
        self.user = self._make_user("a@test.com")
        self.other = self._make_user("b@test.com")
        p1 = patch("app.services.rag_service.ollama_client.get_embeddings_batch", fake_embed_batch_async)
        p2 = patch("app.services.rag_service.ollama_client.get_embedding", fake_embed_one)
        p1.start(); p2.start()
        self.addCleanup(p1.stop); self.addCleanup(p2.stop)

    async def asyncTearDown(self):
        self.db.close()

    def _make_user(self, email):
        u = User(name=email.split("@")[0], email=email, hashed_password="x")
        self.db.add(u); self.db.commit(); self.db.refresh(u)
        return u

    def _make_chat(self, user=None, title="t"):
        c = Chat(title=title, user_id=(user or self.user).id)
        self.db.add(c); self.db.commit(); self.db.refresh(c)
        return c

    def _patch_ai(self, fake):
        p1 = patch.object(cs.ai_service, "stream_chat_response", fake.stream)
        p2 = patch.object(cs.ai_service, "generate_title", fake.generate_title)
        p1.start(); p2.start()
        self.addCleanup(p1.stop); self.addCleanup(p2.stop)

    async def _drain(self, request):
        return [c async for c in cs.chat_service.process_streaming_chat(request, self.user, self.db)]

    def _messages(self, chat_id):
        self.db.expire_all()
        return self.db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.id).all()

    async def _upload(self, text, chat_id=None, user=None, name="notes.txt"):
        return await rag_service.process_and_store_document(
            file_bytes=text.encode(), filename=name, user_id=(user or self.user).id, chat_id=chat_id, db=self.db
        )


class MessageOrderingTests(DBTestCase):
    async def test_same_timestamp_messages_keep_insertion_order(self):
        chat = self._make_chat()
        same = datetime(2024, 1, 1, 12, 0, 0)
        for i in range(8):
            self.db.add(Message(chat_id=chat.id, role="user" if i % 2 == 0 else "assistant", content=f"m{i}", created_at=same))
            self.db.commit()
        history = cs.chat_service.get_chat_history(chat.id, self.user.id, self.db)
        self.assertEqual([m.content for m in history.messages], [f"m{i}" for i in range(8)])

    async def test_streaming_history_passed_to_model_is_chronological(self):
        chat = self._make_chat()
        same = datetime(2024, 1, 1, 12, 0, 0)
        for i in range(4):
            self.db.add(Message(chat_id=chat.id, role="user" if i % 2 == 0 else "assistant", content=f"m{i}", created_at=same))
        self.db.commit()
        fake = FakeAI(); self._patch_ai(fake)
        await self._drain(ChatRequest(message="next", chat_id=chat.id))
        sent = [m["content"] for m in fake.calls[0]["messages_history"]]
        self.assertEqual(sent, ["m0", "m1", "m2", "m3", "next"])

    async def test_new_messages_come_after_old(self):
        fake = FakeAI(); self._patch_ai(fake)
        await self._drain(ChatRequest(message="first"))
        chat_id = self.db.query(Chat).first().id
        await self._drain(ChatRequest(message="second", chat_id=chat_id))
        self.assertEqual([(m.role, m.content) for m in self._messages(chat_id)],
                         [("user", "first"), ("assistant", "Hello world"), ("user", "second"), ("assistant", "Hello world")])


class StreamPersistenceTests(DBTestCase):
    async def test_normal_generation_saves_full_reply(self):
        fake = FakeAI(); self._patch_ai(fake)
        chunks = await self._drain(ChatRequest(message="hi there friend"))
        chat_id = json.loads(chunks[0][6:])["chat_id"]
        msgs = self._messages(chat_id)
        self.assertEqual([m.role for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[1].content, "Hello world")

    async def test_stop_mid_stream_saves_partial_reply(self):
        fake = FakeAI(tokens=("Par", "tial"), hang_after=True); self._patch_ai(fake)
        gen = cs.chat_service.process_streaming_chat(ChatRequest(message="hello hello hello"), self.user, self.db)
        first = await gen.__anext__()           # chat_id
        chat_id = json.loads(first[6:])["chat_id"]
        await gen.__anext__(); await gen.__anext__()   # two tokens
        await gen.aclose()                       # what happens on client disconnect / Stop
        msgs = self._messages(chat_id)
        self.assertEqual([m.role for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[1].content, "Partial")

    async def test_task_cancellation_saves_partial_reply(self):
        fake = FakeAI(tokens=("Cut", " off"), hang_after=True); self._patch_ai(fake)
        got_tokens = asyncio.Event()
        state = {}

        async def consume():
            async for chunk in cs.chat_service.process_streaming_chat(ChatRequest(message="hello hello hello"), self.user, self.db):
                data = json.loads(chunk[6:])
                if "chat_id" in data:
                    state["chat_id"] = data["chat_id"]
                if data.get("token") == " off":
                    got_tokens.set()

        task = asyncio.create_task(consume())
        await asyncio.wait_for(got_tokens.wait(), 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        msgs = self._messages(state["chat_id"])
        self.assertEqual(msgs[-1].role, "assistant")
        self.assertEqual(msgs[-1].content, "Cut off")

    async def test_stop_before_any_token_saves_no_empty_assistant_message(self):
        fake = FakeAI(tokens=(), hang_after=True); self._patch_ai(fake)
        gen = cs.chat_service.process_streaming_chat(ChatRequest(message="hello hello hello"), self.user, self.db)
        chat_id = json.loads((await gen.__anext__())[6:])["chat_id"]
        task = asyncio.ensure_future(gen.__anext__())
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await gen.aclose()
        self.assertEqual([m.role for m in self._messages(chat_id)], ["user"])

    async def test_interrupted_new_chat_does_not_schedule_title(self):
        fake = FakeAI(tokens=("x",), hang_after=True); self._patch_ai(fake)
        gen = cs.chat_service.process_streaming_chat(ChatRequest(message="hello hello hello"), self.user, self.db)
        await gen.__anext__(); await gen.__anext__()
        await gen.aclose()
        self.assertEqual(len(cs._background_tasks), 0)


class TitleGenerationTests(DBTestCase):
    async def test_stream_closes_before_title_and_title_arrives_later(self):
        gate = asyncio.Event()
        fake = FakeAI(title="Concise Title", title_gate=gate); self._patch_ai(fake)
        msg = "Tell me something quite interesting about databases"
        # Whole stream must finish even though the title LLM call is still blocked
        chunks = await asyncio.wait_for(self._drain(ChatRequest(message=msg)), 2)
        chat_id = json.loads(chunks[0][6:])["chat_id"]
        self.db.expire_all()
        chat = self.db.get(Chat, chat_id)
        self.assertEqual(chat.title, msg[:50] + "...")           # fallback title, not yet replaced
        self.assertEqual(self._messages(chat_id)[-1].content, "Hello world")  # reply already saved
        gate.set()
        await asyncio.gather(*list(cs._background_tasks))
        self.db.expire_all()
        self.assertEqual(self.db.get(Chat, chat_id).title, "Concise Title")

    async def test_title_failure_does_not_affect_response(self):
        class Boom(FakeAI):
            async def generate_title(self, message):
                raise RuntimeError("ollama down")
        fake = Boom(); self._patch_ai(fake)
        chunks = await self._drain(ChatRequest(message="Tell me something quite interesting"))
        chat_id = json.loads(chunks[0][6:])["chat_id"]
        await asyncio.gather(*list(cs._background_tasks))
        self.assertEqual(self._messages(chat_id)[-1].content, "Hello world")

    async def test_manual_rename_is_not_overwritten(self):
        gate = asyncio.Event()
        fake = FakeAI(title="AI Title", title_gate=gate); self._patch_ai(fake)
        chunks = await self._drain(ChatRequest(message="Tell me something quite interesting"))
        chat_id = json.loads(chunks[0][6:])["chat_id"]
        cs.chat_service.rename_chat(chat_id, "My Name", self.user.id, self.db)
        gate.set()
        await asyncio.gather(*list(cs._background_tasks))
        self.db.expire_all()
        self.assertEqual(self.db.get(Chat, chat_id).title, "My Name")


class UpdatedAtTests(DBTestCase):
    def _age(self, chat):
        old = datetime(2020, 1, 1, 0, 0, 0)
        self.db.query(Chat).filter(Chat.id == chat.id).update({Chat.updated_at: old})
        self.db.commit()
        return old

    def _updated(self, chat_id):
        self.db.expire_all()
        return self.db.get(Chat, chat_id).updated_at

    async def test_streaming_message_bumps_chat(self):
        chat = self._make_chat(); old = self._age(chat)
        fake = FakeAI(); self._patch_ai(fake)
        await self._drain(ChatRequest(message="hi there friend", chat_id=chat.id))
        self.assertGreater(self._updated(chat.id).replace(tzinfo=None), old)

    async def test_user_message_alone_bumps_chat_even_if_stream_dies(self):
        chat = self._make_chat(); old = self._age(chat)
        fake = FakeAI(tokens=(), hang_after=True); self._patch_ai(fake)
        gen = cs.chat_service.process_streaming_chat(ChatRequest(message="hello hello", chat_id=chat.id), self.user, self.db)
        await gen.__anext__()
        await gen.aclose()
        self.assertGreater(self._updated(chat.id).replace(tzinfo=None), old)

    async def test_partial_assistant_message_bumps_chat(self):
        chat = self._make_chat()
        cs.add_message(self.db, chat.id, "user", "q")
        old = self._age(chat)
        cs.persist_assistant_message(self.db, chat.id, "partial")
        self.assertGreater(self._updated(chat.id).replace(tzinfo=None), old)

    async def test_regenerate_bumps_chat(self):
        chat = self._make_chat()
        cs.add_message(self.db, chat.id, "user", "q"); cs.add_message(self.db, chat.id, "assistant", "old answer")
        old = self._age(chat)
        fake = FakeAI(tokens=("new",)); self._patch_ai(fake)
        _ = [c async for c in cs.chat_service.process_regenerate_stream(chat.id, self.user, self.db)]
        self.assertEqual(self._messages(chat.id)[-1].content, "new")
        self.assertGreater(self._updated(chat.id).replace(tzinfo=None), old)

    async def test_list_ordering_reflects_recent_activity(self):
        older = self._make_chat(title="older"); newer = self._make_chat(title="newer")
        self.db.query(Chat).filter(Chat.id == older.id).update({Chat.updated_at: datetime(2020, 1, 1)})
        self.db.query(Chat).filter(Chat.id == newer.id).update({Chat.updated_at: datetime(2021, 1, 1)})
        self.db.commit()
        self.assertEqual([c.title for c in cs.chat_service.get_user_chats(self.user.id, self.db)], ["newer", "older"])
        cs.add_message(self.db, older.id, "user", "ping")
        self.assertEqual([c.title for c in cs.chat_service.get_user_chats(self.user.id, self.db)], ["older", "newer"])


class QuizTriggerTests(DBTestCase):
    def test_should_trigger(self):
        for text in ["quiz me", "Quiz Me on this document", "test me", "TEST ME please", "start quiz", "Start a quiz"]:
            self.assertTrue(cs.is_quiz_request(text), text)

    def test_should_not_trigger(self):
        for text in ["I have a question about this document", "answer my question", "what is the answer to this question?",
                     "questions about chapter 2", "what is a quiz?", "attest me"]:
            self.assertFalse(cs.is_quiz_request(text), text)

    async def test_end_to_end_quiz_flag(self):
        chat = self._make_chat()
        await self._upload("Photosynthesis converts light into chemical energy in plants. " * 5, chat_id=chat.id)
        fake = FakeAI(); self._patch_ai(fake)
        await self._drain(ChatRequest(message="I have a question about this document", chat_id=chat.id))
        await self._drain(ChatRequest(message="quiz me on this document", chat_id=chat.id))
        self.assertFalse(fake.calls[0]["is_quiz"])
        self.assertTrue(fake.calls[0]["has_document"])
        self.assertTrue(fake.calls[1]["is_quiz"])


class SharedDocumentTests(DBTestCase):
    TEXT = "The mitochondria is the powerhouse of the cell. " * 10

    async def test_same_file_in_two_chats_stays_available_to_both(self):
        a = self._make_chat(title="A"); b = self._make_chat(title="B")
        d1 = await self._upload(self.TEXT, chat_id=a.id)
        d2 = await self._upload(self.TEXT, chat_id=b.id)
        self.assertEqual(d1.id, d2.id)                         # content deduplicated
        self.assertEqual(self.db.query(Document).count(), 1)
        fake = FakeAI(); self._patch_ai(fake)
        # Chat B uses the document via document_id (the path that used to MOVE it)
        await self._drain(ChatRequest(message="summarize the document", chat_id=b.id, document_id=d2.id))
        for chat in (a, b):
            docs = rag_service.get_chat_documents(self.db, chat.id, self.user.id)
            self.assertEqual([d.id for d in docs], [d1.id], f"chat {chat.title}")
            chunks = await rag_service.retrieve_relevant_chunks("mitochondria", self.user.id, chat_id=chat.id, db=self.db)
            self.assertTrue(chunks, f"chat {chat.title} lost retrieval")
        # Chat A still gets document context in its own conversation
        await self._drain(ChatRequest(message="what does the document say about mitochondria?", chat_id=a.id))
        self.assertTrue(fake.calls[-1]["has_document"])
        self.assertIn("<uploaded_document", fake.calls[-1]["messages_history"][-1]["content"])

    async def test_upload_without_chat_then_attach_on_message(self):
        d = await self._upload(self.TEXT)  # no chat yet (new-chat flow)
        fake = FakeAI(); self._patch_ai(fake)
        chunks = await self._drain(ChatRequest(message="summarize the document", document_id=d.id))
        chat_id = json.loads(chunks[0][6:])["chat_id"]
        self.assertEqual([x.id for x in rag_service.get_chat_documents(self.db, chat_id, self.user.id)], [d.id])
        self.assertTrue(fake.calls[0]["has_document"])

    async def test_isolation_between_chats_and_users(self):
        a = self._make_chat(title="A"); c = self._make_chat(title="C")
        await self._upload(self.TEXT, chat_id=a.id)
        # Chat without the document gets nothing
        self.assertEqual(await rag_service.retrieve_relevant_chunks("mitochondria", self.user.id, chat_id=c.id, db=self.db), [])
        # Another user cannot read it even by guessing the chat id
        self.assertEqual(await rag_service.retrieve_relevant_chunks("mitochondria", self.other.id, chat_id=a.id, db=self.db), [])
        # Another user's document_id cannot be attached to my chat
        fake = FakeAI(); self._patch_ai(fake)
        other_doc = await self._upload("Secret material about launch codes. " * 10, user=self.other, name="secret.txt")
        await self._drain(ChatRequest(message="summarize the document", chat_id=c.id, document_id=other_doc.id))
        self.assertEqual(rag_service.get_chat_documents(self.db, c.id, self.user.id), [])
        self.assertFalse(fake.calls[-1]["has_document"])

    async def test_deleting_chat_keeps_document_used_elsewhere(self):
        a = self._make_chat(title="A"); b = self._make_chat(title="B")
        d = await self._upload(self.TEXT, chat_id=a.id)
        await self._upload(self.TEXT, chat_id=b.id)
        self.assertTrue(cs.chat_service.delete_chat(a.id, self.user.id, self.db))
        self.assertIsNotNone(self.db.get(Document, d.id))
        self.assertTrue(await rag_service.retrieve_relevant_chunks("mitochondria", self.user.id, chat_id=b.id, db=self.db))
        self.assertTrue(cs.chat_service.delete_chat(b.id, self.user.id, self.db))
        self.db.expire_all()
        self.assertIsNone(self.db.get(Document, d.id))
        self.assertEqual(self.db.execute(chat_documents.select()).all(), [])

    async def test_legacy_chat_id_column_is_backfilled(self):
        from sqlalchemy import text
        a = self._make_chat(title="A")
        d = await self._upload(self.TEXT)
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE documents ADD COLUMN chat_id INTEGER"))
            conn.execute(text("UPDATE documents SET chat_id = :c WHERE id = :d"), {"c": a.id, "d": d.id})
            conn.execute(text("DROP TABLE alembic_version"))  # a database from before migrations were introduced
        init_db()
        self.assertEqual([x.id for x in rag_service.get_chat_documents(self.db, a.id, self.user.id)], [d.id])
        init_db()  # idempotent
        self.assertEqual(len(self.db.execute(chat_documents.select()).all()), 1)


class UploadExtractionTests(DBTestCase):
    async def test_extraction_runs_once_and_off_the_event_loop(self):
        loop_thread = threading.get_ident()
        calls = []
        original = RAGService.extract_document_sync

        def spy(file_bytes, filename):
            calls.append(threading.get_ident())
            return original(file_bytes, filename)

        with patch.object(RAGService, "extract_document_sync", staticmethod(spy)):
            doc = await self._upload("Quarterly revenue grew strongly across all regions. " * 20)
        self.assertEqual(len(calls), 1)
        self.assertNotEqual(calls[0], loop_thread)
        self.assertGreater(len(doc.chunks), 0)

        # Duplicate upload: no extraction at all
        with patch.object(RAGService, "extract_document_sync", staticmethod(spy)):
            await self._upload("Quarterly revenue grew strongly across all regions. " * 20)
        self.assertEqual(len(calls), 1)

    async def test_event_loop_stays_responsive_during_extraction(self):
        original = RAGService.extract_document_sync

        def slow(file_bytes, filename):
            time.sleep(0.4)
            return original(file_bytes, filename)

        ticks = []

        async def ticker():
            while True:
                ticks.append(time.perf_counter()); await asyncio.sleep(0.02)

        t = asyncio.create_task(ticker())
        with patch.object(RAGService, "extract_document_sync", staticmethod(slow)):
            await self._upload("Blocking check document text. " * 20)
        t.cancel()
        gaps = [b - a for a, b in zip(ticks, ticks[1:])]
        self.assertGreater(len(ticks), 8)
        self.assertLess(max(gaps), 0.25)

    async def test_upload_route_response_has_no_extracted_text(self):
        from fastapi.testclient import TestClient
        from app.main import app
        from app.api.dependencies import get_current_user
        from app.database.session import get_db
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[get_db] = lambda: self.db
        try:
            client = TestClient(app)
            res = await asyncio.to_thread(
                client.post, "/upload", files={"file": ("n.txt", ("Alpha beta gamma delta. " * 20).encode())}
            )
        finally:
            app.dependency_overrides.clear()
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertNotIn("extracted_text", body)
        self.assertEqual(set(body), {"id", "filename", "file_type", "character_count", "chunk_count"})
        self.assertGreater(body["chunk_count"], 0)

    async def test_citations_still_built_from_chunks(self):
        chat = self._make_chat()
        await self._upload("The capital of Australia is Canberra. " * 10, chat_id=chat.id, name="geo.txt")
        chunks = await rag_service.retrieve_relevant_chunks("capital", self.user.id, chat_id=chat.id, db=self.db)
        ctx = rag_service.build_defensive_context(chunks)
        self.assertIn('<uploaded_document filename="geo.txt"', ctx)
        self.assertIn("Canberra", ctx)

    async def test_fallback_context_comes_from_server_storage(self):
        chat = self._make_chat()
        await self._upload("Zebra facts live here. " * 10, chat_id=chat.id)
        text = rag_service.build_fallback_context(self.db, chat.id, self.user.id, 100)
        self.assertIn("Zebra", text)
        self.assertIn("truncated", text)
        self.assertEqual(rag_service.build_fallback_context(self.db, chat.id, self.other.id, 100), "")


class PromptTests(unittest.TestCase):
    def test_no_code_leaks_into_system_prompt(self):
        for kwargs in ({}, {"has_document": True, "is_quiz": True}, {"is_voice": True}):
            prompt = get_system_prompt(user_name="Sam", **kwargs)
            self.assertNotIn("BASE_SYSTEM_PROMPT", prompt)
            self.assertNotIn("CORE_SYSTEM_PROMPT", prompt)
            self.assertNotIn("{current_date}", prompt)
        self.assertTrue(get_system_prompt().startswith("You are Lumina"))
        self.assertNotIn("BASE_SYSTEM_PROMPT", CORE_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
