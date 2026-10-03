"""Batch 4D: lazy TTS initialization, SQLite foreign keys, messages.chat_id index migration, health endpoint."""
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from app.ai import tts as tts_module
from app.ai.tts import KokoroTTSService, TTSUnavailableError
from app.api.routes import health as health_module
from app.core.config import settings
from app.database import database as database_module
from app.database.database import Base, SessionLocal, engine, enable_sqlite_foreign_keys
from app.database.init_db import init_db, migrate_schema
from app.main import app
from app.models import chat as _chat, document as _document, message as _message, user as _user  # noqa: F401  (register models)

BACKEND = pathlib.Path(__file__).resolve().parents[1]


# ============================================================================================ lazy TTS
class FakeWorker:
    def __init__(self):
        self.calls = 0

    def create(self, chunk, voice, speed, lang):
        self.calls += 1
        return np.zeros(2400, dtype=np.float32), 24000


class ModelFixture:
    """Patches the heavy bits of the loader and counts how many 'models' were built."""

    def __init__(self, delay=0.0, files_exist=True):
        self.sessions = 0
        self.workers = []
        self.delay = delay
        self.files_exist = files_exist
        self._patches = []

    def __enter__(self):
        def fake_session(model_path, options, providers):
            time.sleep(self.delay)
            self.sessions += 1
            return MagicMock()

        def fake_from_session(sess, voices_path):
            worker = FakeWorker()
            self.workers.append(worker)
            return worker

        self._patches = [
            patch.object(tts_module.os.path, "exists", return_value=self.files_exist),
            patch.object(tts_module.ort, "InferenceSession", fake_session),
            patch.object(tts_module.Kokoro, "from_session", fake_from_session),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


class LazyTTSTests(unittest.TestCase):
    def test_importing_tts_module_builds_no_model_session(self):
        script = (
            "import onnxruntime as ort\n"
            "calls=[]\n"
            "orig=ort.InferenceSession\n"
            "def counting(*a, **k):\n"
            "    calls.append(1); return orig(*a, **k)\n"
            "ort.InferenceSession=counting\n"
            "import app.ai.tts as t\n"
            "print('sessions=%d loaded=%s pool=%d' % (len(calls), t.tts_service.is_loaded, t.tts_service._pool.qsize()))\n"
        )
        env = {**os.environ, "DATABASE_URL": "sqlite://", "SECRET_KEY": "x" * 40}
        out = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr[-500:])
        self.assertIn("sessions=0 loaded=False pool=0", out.stdout)

    def test_constructing_the_service_loads_nothing(self):
        with ModelFixture() as fx:
            svc = KokoroTTSService(pool_size=2)
        self.assertEqual(fx.sessions, 0)
        self.assertFalse(svc.is_loaded)
        self.assertEqual(svc._pool.qsize(), 0)

    def test_availability_and_status_checks_never_load(self):
        with ModelFixture() as fx:
            svc = KokoroTTSService(pool_size=2)
            self.assertTrue(svc.is_available)
            self.assertEqual(svc.status(), "not_loaded")
        self.assertEqual(fx.sessions, 0)
        self.assertFalse(svc.is_loaded)

    def test_status_when_model_files_are_missing(self):
        with ModelFixture(files_exist=False):
            svc = KokoroTTSService(pool_size=2)
            self.assertFalse(svc.is_available)
            self.assertEqual(svc.status(), "unavailable")

    def test_first_synthesis_loads_pool_with_configured_threads_and_later_calls_reuse_it(self):
        seen_threads = []
        with ModelFixture() as fx, patch.object(settings, "KOKORO_THREADS", 3):
            original = tts_module.ort.InferenceSession

            def spy(model_path, options, providers):
                seen_threads.append(options.intra_op_num_threads)
                return original(model_path, options, providers)

            with patch.object(tts_module.ort, "InferenceSession", spy):
                svc = KokoroTTSService(pool_size=2)
                wav = svc.generate_speech("Hello there.")
                self.assertTrue(wav.startswith(b"RIFF"))
                self.assertTrue(svc.is_loaded)
                self.assertEqual(svc.status(), "ready")
                self.assertEqual(fx.sessions, 2)
                self.assertEqual(seen_threads, [3, 3])
                for _ in range(5):
                    svc.generate_speech("Hello again.")
        self.assertEqual(fx.sessions, 2, "no extra models after the first load")
        self.assertEqual(len(fx.workers), 2)
        self.assertEqual(svc._pool.qsize(), 2, "all workers returned to the pool")
        self.assertEqual(sum(w.calls for w in fx.workers), 6)

    def test_concurrent_first_calls_build_the_pool_exactly_once(self):
        results, errors = [], []
        with ModelFixture(delay=0.15) as fx:
            svc = KokoroTTSService(pool_size=2)
            barrier = threading.Barrier(8)

            def worker():
                try:
                    barrier.wait(timeout=5)
                    results.append(svc.generate_speech("Hello from a concurrent request."))
                except Exception as e:  # noqa: BLE001
                    errors.append(e)

            threads = [threading.Thread(target=worker, daemon=True) for _ in range(8)]
            for t in threads:
                t.start()
            deadline = time.monotonic() + 15
            for t in threads:
                t.join(timeout=max(0.0, deadline - time.monotonic()))
            # a duplicate loader would overfill the bounded pool and block forever, so assert nobody is stuck
            self.assertFalse(any(t.is_alive() for t in threads), "request threads are stuck (duplicate pool initialization?)")
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 8)
        self.assertEqual(fx.sessions, 2, "exactly pool_size sessions, never duplicated")
        self.assertEqual(len(fx.workers), 2)
        self.assertEqual(svc._pool.qsize(), 2)

    def test_concurrent_ensure_loaded_calls_run_the_loader_once(self):
        calls = []
        svc = KokoroTTSService(pool_size=1)

        def slow_loader():
            calls.append(1)
            time.sleep(0.1)
            svc.is_loaded = True

        svc._init_model_pool = slow_loader
        threads = [threading.Thread(target=svc.ensure_loaded, daemon=True) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        self.assertEqual(len(calls), 1)

    def test_failed_load_is_reported_safely_and_not_retried(self):
        with ModelFixture(files_exist=False) as fx:
            svc = KokoroTTSService(pool_size=2)
            for _ in range(3):
                with self.assertRaises(TTSUnavailableError):
                    svc.generate_speech("Hello there.")
        self.assertEqual(fx.sessions, 0)

    def test_load_error_during_first_request_becomes_unavailable_and_is_remembered(self):
        attempts = []

        def exploding_session(*a, **k):
            attempts.append(1)
            raise RuntimeError("onnx exploded at /private/path")

        with ModelFixture() as _fx, patch.object(tts_module.ort, "InferenceSession", exploding_session):
            svc = KokoroTTSService(pool_size=2)
            with self.assertRaises(TTSUnavailableError):
                svc.generate_speech("Hello there.")
            self.assertEqual(svc.status(), "unavailable")
            with self.assertRaises(TTSUnavailableError):
                svc.generate_speech("Hello there.")
        self.assertEqual(len(attempts), 1, "a failed load is not retried on every request")

    def test_route_first_request_loads_and_serves(self):
        from app.api.dependencies import get_current_user
        app.dependency_overrides[get_current_user] = lambda: object()
        try:
            with ModelFixture() as fx:
                svc = KokoroTTSService(pool_size=2)
                with patch("app.api.routes.tts.tts_service", svc):
                    client = TestClient(app)
                    first = client.post("/tts", json={"text": "Hello there."})
                    second = client.post("/tts", json={"text": "Hello again."})
            self.assertEqual((first.status_code, second.status_code), (200, 200))
            self.assertTrue(first.content.startswith(b"RIFF"))
            self.assertEqual(fx.sessions, 2)
        finally:
            app.dependency_overrides.clear()


# ============================================================================================ foreign keys
def temp_engine():
    handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    handle.close()
    eng = create_engine(f"sqlite:///{handle.name}", connect_args={"check_same_thread": False})
    enable_sqlite_foreign_keys(eng)
    Base.metadata.create_all(bind=eng)
    return eng, handle.name


def seed(conn):
    conn.execute(text("INSERT INTO users (id, name, email, hashed_password) VALUES (1, 'U', 'u@x.com', 'h')"))
    conn.execute(text("INSERT INTO chats (id, title, user_id) VALUES (10, 'A', 1), (11, 'B', 1)"))
    conn.execute(text("INSERT INTO messages (id, chat_id, role, content) VALUES (1, 10, 'user', 'hi'), (2, 10, 'assistant', 'yo')"))
    conn.execute(text("INSERT INTO documents (id, user_id, filename, file_type, file_hash, char_count) VALUES (5, 1, 'd.txt', 'txt', 'h', 3)"))
    conn.execute(text("INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding_json) VALUES (1, 5, 0, 'c', '[]')"))
    conn.execute(text("INSERT INTO chat_documents (chat_id, document_id) VALUES (10, 5), (11, 5)"))


class ForeignKeyTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(bind=engine)
        init_db()

    def test_pragma_is_on_for_every_application_connection(self):
        with engine.connect() as c1, engine.connect() as c2:
            self.assertEqual(c1.execute(text("PRAGMA foreign_keys")).scalar(), 1)
            self.assertEqual(c2.execute(text("PRAGMA foreign_keys")).scalar(), 1)
        session = SessionLocal()
        try:
            self.assertEqual(session.execute(text("PRAGMA foreign_keys")).scalar(), 1)
        finally:
            session.close()
        with engine.connect() as again:  # a pooled/reused connection keeps it
            self.assertEqual(again.execute(text("PRAGMA foreign_keys")).scalar(), 1)

    def test_pragma_is_on_for_the_engine_used_by_the_api(self):
        self.assertIs(database_module.engine, engine)
        res = TestClient(app).get("/health")
        self.assertIn(res.status_code, (200, 503))
        with SessionLocal() as s:
            self.assertEqual(s.execute(text("PRAGMA foreign_keys")).scalar(), 1)

    def test_pragma_set_on_a_temporary_engine_too_and_not_without_the_helper(self):
        eng, path = temp_engine()
        try:
            with eng.connect() as c:
                self.assertEqual(c.execute(text("PRAGMA foreign_keys")).scalar(), 1)
        finally:
            eng.dispose(); os.unlink(path)
        plain = create_engine("sqlite://")
        with plain.connect() as c:
            self.assertEqual(c.execute(text("PRAGMA foreign_keys")).scalar(), 0, "SQLite default is OFF: the helper is what turns it on")

    def test_non_sqlite_engines_are_left_alone(self):
        fake = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        with patch.object(database_module.event, "listens_for") as listens:
            enable_sqlite_foreign_keys(fake)
        listens.assert_not_called()

    def test_orphan_rows_are_rejected(self):
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO users (id, name, email, hashed_password) VALUES (1, 'U', 'u@x.com', 'h')"))
        with self.assertRaises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO messages (chat_id, role, content) VALUES (999, 'user', 'orphan')"))
        with self.assertRaises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO chats (title, user_id) VALUES ('x', 424242)"))

    def test_deleting_a_chat_with_messages_is_blocked_at_database_level(self):
        # messages.chat_id has no ON DELETE action: only the ORM (which deletes messages first) may delete a chat
        with engine.begin() as conn:
            seed(conn)
        with self.assertRaises(IntegrityError):
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM chats WHERE id = 10"))

    def test_on_delete_cascade_chat_documents_follow_a_deleted_chat(self):
        with engine.begin() as conn:
            seed(conn)
            conn.execute(text("DELETE FROM messages WHERE chat_id = 11"))
            conn.execute(text("DELETE FROM chats WHERE id = 11"))   # chat 11 has no messages
            links = conn.execute(text("SELECT chat_id FROM chat_documents ORDER BY chat_id")).scalars().all()
        self.assertEqual(links, [10], "the link row of the deleted chat was cascade-deleted by the database")

    def test_on_delete_cascade_user_to_documents_to_chunks_and_links(self):
        with engine.begin() as conn:
            seed(conn)
            conn.execute(text("DELETE FROM messages"))
            conn.execute(text("DELETE FROM chats"))              # also removes the links (cascade)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM chat_documents")).scalar(), 0)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 1)
            conn.execute(text("DELETE FROM users WHERE id = 1"))  # documents -> chunks cascade
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 0)
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM document_chunks")).scalar(), 0)

    def test_orm_delete_paths_still_work_with_enforcement(self):
        from app.services.chat_service import chat_service
        with engine.begin() as conn:
            seed(conn)
        db = SessionLocal()
        try:
            self.assertTrue(chat_service.delete_chat(10, 1, db))
            db.expire_all()
            self.assertEqual(db.execute(text("SELECT COUNT(*) FROM messages")).scalar(), 0)
            self.assertEqual(db.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 1, "document still used by chat 11")
            self.assertTrue(chat_service.delete_chat(11, 1, db))
            self.assertEqual(db.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 0)
        finally:
            db.close()

    def test_legacy_document_chat_id_cascade_would_delete_shared_documents_so_migration_clears_it(self):
        def legacy_db():
            eng, path = temp_engine()
            with eng.begin() as conn:
                conn.execute(text("ALTER TABLE documents ADD COLUMN chat_id INTEGER REFERENCES chats (id) ON DELETE CASCADE"))
                seed(conn)
                conn.execute(text("DELETE FROM messages"))
                conn.execute(text("UPDATE documents SET chat_id = 10 WHERE id = 5"))   # legacy reference to chat A
            return eng, path

        # control: with the legacy FK enforced and not migrated, deleting chat A also deletes the document shared with chat B
        eng, path = legacy_db()
        try:
            with eng.begin() as conn:
                conn.execute(text("DELETE FROM chats WHERE id = 10"))
                self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 0)
        finally:
            eng.dispose(); os.unlink(path)

        # after the migration the legacy reference is cleared (the link rows keep the relationship) and the document survives
        eng, path = legacy_db()
        try:
            migrate_schema(eng)
            with eng.begin() as conn:
                self.assertIsNone(conn.execute(text("SELECT chat_id FROM documents WHERE id = 5")).scalar())
                self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM chat_documents")).scalar(), 2)
                conn.execute(text("DELETE FROM chats WHERE id = 10"))
                self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM documents")).scalar(), 1)
                self.assertEqual(conn.execute(text("SELECT chat_id FROM chat_documents")).scalars().all(), [11])
            migrate_schema(eng)  # idempotent
        finally:
            eng.dispose(); os.unlink(path)

    def test_migration_never_clears_a_legacy_reference_without_a_matching_link(self):
        eng, path = temp_engine()
        try:
            with eng.begin() as conn:
                conn.execute(text("ALTER TABLE documents ADD COLUMN chat_id INTEGER REFERENCES chats (id) ON DELETE CASCADE"))
                conn.execute(text("INSERT INTO users (id, name, email, hashed_password) VALUES (1, 'U', 'u@x.com', 'h')"))
                conn.execute(text("INSERT INTO chats (id, title, user_id) VALUES (10, 'A', 1), (11, 'B', 1)"))
                conn.execute(text("INSERT INTO documents (id, user_id, filename, file_type, file_hash, char_count, chat_id) VALUES (5, 1, 'd', 'txt', 'h', 1, 10)"))
                # an unrelated link exists, so the 'backfill only when empty' step is skipped and chat 10 has no link row
                conn.execute(text("INSERT INTO documents (id, user_id, filename, file_type, file_hash, char_count) VALUES (6, 1, 'e', 'txt', 'h2', 1)"))
                conn.execute(text("INSERT INTO chat_documents (chat_id, document_id) VALUES (11, 6)"))
            migrate_schema(eng)
            with eng.begin() as conn:
                self.assertEqual(conn.execute(text("SELECT chat_id FROM documents WHERE id = 5")).scalar(), 10, "kept: no link row records it")
        finally:
            eng.dispose(); os.unlink(path)


# ============================================================================================ messages index
class MessagesIndexTests(unittest.TestCase):
    def indexes(self, eng):
        return {i["name"]: i["column_names"] for i in inspect(eng).get_indexes("messages")}

    def test_model_declares_the_index_and_new_databases_get_it(self):
        eng, path = temp_engine()
        try:
            self.assertEqual(self.indexes(eng).get("ix_messages_chat_id"), ["chat_id"])
            self.assertTrue(_message.Message.__table__.c.chat_id.index)
        finally:
            eng.dispose(); os.unlink(path)

    def test_application_database_has_the_index_and_queries_use_it(self):
        Base.metadata.drop_all(bind=engine)
        init_db()
        self.assertEqual(self.indexes(engine).get("ix_messages_chat_id"), ["chat_id"])
        with engine.connect() as conn:
            plan = " ".join(str(r) for r in conn.execute(text("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE chat_id = 1")).fetchall())
        self.assertIn("ix_messages_chat_id", plan)

    def test_existing_database_without_the_index_receives_it_idempotently_without_touching_data(self):
        eng, path = temp_engine()
        try:
            with eng.begin() as conn:
                seed(conn)
                conn.execute(text("DROP INDEX ix_messages_chat_id"))
            self.assertNotIn("ix_messages_chat_id", self.indexes(eng))
            before = None
            with eng.connect() as conn:
                before = conn.execute(text("SELECT id, chat_id, role, content, created_at FROM messages ORDER BY id")).fetchall()
            migrate_schema(eng)
            migrate_schema(eng)  # twice: safe to repeat
            migrate_schema(eng)
            self.assertEqual(self.indexes(eng).get("ix_messages_chat_id"), ["chat_id"])
            with eng.connect() as conn:
                after = conn.execute(text("SELECT id, chat_id, role, content, created_at FROM messages ORDER BY id")).fetchall()
            self.assertEqual(before, after)
            self.assertEqual(len(after), 2)
        finally:
            eng.dispose(); os.unlink(path)

    def test_create_all_on_an_existing_database_does_not_conflict_with_the_migration(self):
        eng, path = temp_engine()
        try:
            with eng.begin() as conn:
                conn.execute(text("DROP INDEX ix_messages_chat_id"))
            Base.metadata.create_all(bind=eng)   # existing tables: indexes are not recreated
            migrate_schema(eng)
            Base.metadata.create_all(bind=eng)
            self.assertEqual(list(self.indexes(eng)).count("ix_messages_chat_id"), 1)
        finally:
            eng.dispose(); os.unlink(path)

    def test_migration_without_a_messages_table_is_a_noop(self):
        eng = create_engine("sqlite://")
        migrate_schema(eng)  # nothing to migrate, must not raise or create tables
        self.assertEqual(inspect(eng).get_table_names(), [])


# ============================================================================================ health
def models_response(*names):
    return SimpleNamespace(models=[SimpleNamespace(model=n) for n in names])


class HealthTests(unittest.TestCase):
    SHAPE = {"status", "database", "ollama", "tts"}

    def setUp(self):
        Base.metadata.drop_all(bind=engine)
        init_db()
        self.client = TestClient(app)

    def get(self, ollama=None, tts="ready", db_engine=None, timeout=None):
        ollama_mock = ollama if ollama is not None else AsyncMock(return_value=models_response(settings.OLLAMA_PRIMARY_MODEL, settings.OLLAMA_FALLBACK_MODEL))
        patches = [
            patch.object(health_module.ollama_client, "list_models", ollama_mock),
            patch.object(health_module, "tts_service", SimpleNamespace(status=lambda: tts)),
        ]
        if db_engine is not None:
            patches.append(patch.object(health_module, "engine", db_engine))
        if timeout is not None:
            patches.append(patch.object(health_module, "OLLAMA_CHECK_TIMEOUT_SECONDS", timeout))
        for p in patches:
            p.start()
        try:
            return self.client.get("/health")
        finally:
            for p in patches:
                p.stop()

    def test_all_dependencies_up_is_healthy_200_with_stable_shape(self):
        res = self.get()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "healthy", "database": "healthy", "ollama": "healthy", "tts": "ready"})

    def test_tts_not_loaded_yet_is_still_healthy(self):
        res = self.get(tts="not_loaded")
        self.assertEqual((res.status_code, res.json()["status"], res.json()["tts"]), (200, "healthy", "not_loaded"))

    def test_tts_unavailable_degrades(self):
        res = self.get(tts="unavailable")
        self.assertEqual((res.status_code, res.json()["status"], res.json()["tts"]), (200, "degraded", "unavailable"))

    def test_ollama_down_degrades_but_keeps_http_200(self):
        res = self.get(ollama=AsyncMock(side_effect=ConnectionError("connection refused 127.0.0.1:11434")))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"status": "degraded", "database": "healthy", "ollama": "unhealthy", "tts": "ready"})

    def test_ollama_up_but_no_configured_chat_model_installed_degrades(self):
        res = self.get(ollama=AsyncMock(return_value=models_response("some-other-model:latest", "nomic-embed-text:latest")))
        self.assertEqual(res.json()["ollama"], "unhealthy")
        self.assertEqual(res.json()["status"], "degraded")

    def test_only_the_fallback_model_installed_is_enough(self):
        res = self.get(ollama=AsyncMock(return_value=models_response(settings.OLLAMA_FALLBACK_MODEL)))
        self.assertEqual(res.json()["ollama"], "healthy")

    def test_dict_style_ollama_response_is_understood(self):
        res = self.get(ollama=AsyncMock(return_value={"models": [{"model": settings.OLLAMA_FALLBACK_MODEL}]}))
        self.assertEqual(res.json()["ollama"], "healthy")

    def test_hung_ollama_does_not_hang_the_health_check(self):
        async def hang():
            await asyncio.sleep(30)
        started = time.perf_counter()
        res = self.get(ollama=AsyncMock(side_effect=hang), timeout=0.1)
        self.assertLess(time.perf_counter() - started, 3)
        self.assertEqual(res.json()["ollama"], "unhealthy")
        self.assertEqual(res.status_code, 200)

    def test_database_down_is_unavailable_with_http_503(self):
        broken = MagicMock()
        broken.connect.side_effect = RuntimeError("could not open sqlite:///secret/path/lumina.db password=hunter2")
        res = self.get(db_engine=broken)
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.json(), {"status": "unavailable", "database": "unhealthy", "ollama": "healthy", "tts": "ready"})

    def test_no_internal_details_are_leaked(self):
        broken = MagicMock()
        broken.connect.side_effect = RuntimeError("sqlite:///secret/path/lumina.db password=hunter2 Traceback")
        res = self.get(ollama=AsyncMock(side_effect=ConnectionError("http://internal-host:11434 refused")), db_engine=broken)
        for leak in ("secret", "hunter2", "Traceback", "internal-host", "sqlite:///", "RuntimeError", "ConnectionError", settings.SECRET_KEY[:8]):
            self.assertNotIn(leak, res.text)
        self.assertEqual(set(res.json()), self.SHAPE)

    def test_internal_errors_are_logged_server_side(self):
        broken = MagicMock()
        broken.connect.side_effect = RuntimeError("db exploded")
        with self.assertLogs("app.api.routes.health", level="WARNING") as logs:
            self.get(db_engine=broken)
        self.assertTrue(any("db exploded" in line for line in logs.output))

    def test_health_never_loads_the_tts_model(self):
        svc = KokoroTTSService(pool_size=2)
        with patch.object(svc, "_init_model_pool", side_effect=AssertionError("health must not load the model")) as loader, \
             patch.object(health_module, "tts_service", svc), \
             patch.object(health_module.ollama_client, "list_models", AsyncMock(return_value=models_response(settings.OLLAMA_FALLBACK_MODEL))):
            for _ in range(3):
                res = self.client.get("/health")
                self.assertEqual(res.status_code, 200)
                self.assertIn(res.json()["tts"], ("not_loaded", "unavailable"))
        loader.assert_not_called()
        self.assertFalse(svc.is_loaded)

    def test_health_does_not_generate_with_ollama(self):
        chat = AsyncMock()
        with patch.object(health_module.ollama_client, "generate_chat", chat), \
             patch.object(health_module.ollama_client, "get_embedding", chat), \
             patch.object(health_module.ollama_client, "list_models", AsyncMock(return_value=models_response(settings.OLLAMA_FALLBACK_MODEL))):
            self.client.get("/health")
        chat.assert_not_called()

    def test_real_application_dependencies_give_a_valid_response(self):
        res = self.client.get("/health")
        self.assertIn(res.status_code, (200, 503))
        body = res.json()
        self.assertEqual(set(body), self.SHAPE)
        self.assertIn(body["status"], {"healthy", "degraded", "unavailable"})
        self.assertEqual(body["database"], "healthy")   # the test database is reachable
        self.assertIn(body["tts"], {"ready", "not_loaded", "unavailable"})

    def test_root_endpoint_unchanged(self):
        self.assertEqual(self.client.get("/").json(), {"message": "Welcome to Lumina AI Backend"})


import asyncio  # noqa: E402  (used by the hung-Ollama test)

if __name__ == "__main__":
    unittest.main()
