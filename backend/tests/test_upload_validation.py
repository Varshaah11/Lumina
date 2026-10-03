import asyncio
import io
import unittest
import zipfile
from unittest.mock import patch

import docx
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.core.body_limit import BODY_OVERHEAD_ALLOWANCE
from app.core.config import Settings, settings
from app.database.database import Base, SessionLocal, engine
from app.database.init_db import init_db
from app.database.session import get_db
from app.main import app
from app.models.chat import Chat
from app.models.document import Document, chat_documents
from app.models.user import User
from app.services import upload_validation as uv
from app.services.rag_service import RAGService, rag_service

TEST_LIMIT_MB = 0.1                       # 104,857 bytes: small boundary fixtures (python-docx files are ~36 KB)
LIMIT = int(TEST_LIMIT_MB * 1024 * 1024)


def make_pdf(text="Hello Lumina uploaded PDF document with enough words to be chunked."):
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def make_docx(text="Hello Lumina uploaded DOCX document with enough words to be chunked."):
    buf = io.BytesIO()
    d = docx.Document()
    d.add_paragraph(text)
    d.save(buf)
    return buf.getvalue()


def make_zip_without_word_parts():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("hello.txt", "not an office document")
    return buf.getvalue()


TXT = b"Plain text notes about the Zephyr project. The project lead is Marisol Vega.\n" * 3


class UploadTestCase(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(bind=engine)
        init_db()
        self.db = SessionLocal()
        self.user = self._user("a@test.com")
        self.other = self._user("b@test.com")
        self.current = self.user
        app.dependency_overrides[get_current_user] = lambda: self.current
        app.dependency_overrides[get_db] = lambda: self.db
        for p in (
            patch.object(settings, "MAX_UPLOAD_SIZE_MB", TEST_LIMIT_MB),
            patch("app.services.rag_service.ollama_client.get_embeddings_batch", self._embed),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.clear()
        self.db.close()

    @staticmethod
    async def _embed(texts, model=None):
        return [[1.0, 0.0, 0.5] for _ in texts]

    def _user(self, email):
        u = User(name=email.split("@")[0], email=email, hashed_password="x")
        self.db.add(u); self.db.commit(); self.db.refresh(u)
        return u

    def _chat(self, user=None):
        c = Chat(title="t", user_id=(user or self.user).id)
        self.db.add(c); self.db.commit(); self.db.refresh(c)
        return c

    def upload(self, name, data, content_type="application/octet-stream", chat_id=None, client=None):
        files = {"file": (name, data, content_type)}
        form = {"chat_id": str(chat_id)} if chat_id else None
        return (client or self.client).post("/upload", files=files, data=form)

    def doc_count(self):
        self.db.expire_all()
        return self.db.query(Document).count()

    def spy_extraction(self):
        original = RAGService.extract_document_sync
        calls = []

        def spy(file_bytes, filename):
            calls.append(filename)
            return original(file_bytes, filename)

        p = patch.object(RAGService, "extract_document_sync", staticmethod(spy))
        p.start(); self.addCleanup(p.stop)
        return calls


class SupportedFormatTests(UploadTestCase):
    def test_valid_pdf(self):
        res = self.upload("report.pdf", make_pdf(), "application/pdf")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual((body["filename"], body["file_type"]), ("report.pdf", "pdf"))
        self.assertGreater(body["chunk_count"], 0)
        self.assertNotIn("extracted_text", body)

    def test_valid_docx(self):
        res = self.upload("notes.docx", make_docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["file_type"], "docx")

    def test_valid_txt_and_md(self):
        self.assertEqual(self.upload("n.txt", TXT, "text/plain").status_code, 200)
        self.assertEqual(self.upload("n.md", b"# Title\n\nSome markdown body text for the document.", "text/markdown").status_code, 200)

    def test_latin1_text_still_accepted(self):
        self.assertEqual(self.upload("n.txt", "Caf\xe9 au lait menu notes for the day.".encode("latin-1")).status_code, 200)

    def test_unsupported_extension(self):
        calls = self.spy_extraction()
        for name in ("a.exe", "a.png", "a.docm", "a.pdf.exe", "noextension", "a.TXTX"):
            res = self.upload(name, TXT)
            self.assertEqual(res.status_code, 400, name)
            self.assertEqual(res.json()["detail"], uv.MSG_UNSUPPORTED_TYPE)
        self.assertEqual(calls, [])
        self.assertEqual(self.doc_count(), 0)

    def test_uppercase_extension_is_fine(self):
        self.assertEqual(self.upload("REPORT.PDF", make_pdf()).status_code, 200)


class ContentValidationTests(UploadTestCase):
    def reject(self, name, data, content_type="application/octet-stream", expected=uv.MSG_INVALID_CONTENT, status=400):
        calls = self.spy_extraction()
        res = self.upload(name, data, content_type)
        self.assertEqual(res.status_code, status, f"{name}: {res.text}")
        self.assertEqual(res.json()["detail"], expected)
        self.assertEqual(calls, [], "extraction must not run for rejected uploads")
        self.assertEqual(self.doc_count(), 0, "no document row for rejected uploads")

    def test_fake_pdf(self):
        self.reject("report.pdf", b"This is just text pretending to be a PDF." * 5, "application/pdf")

    def test_fake_pdf_binary(self):
        self.reject("report.pdf", bytes(range(256)) * 8, "application/pdf")

    def test_fake_docx_plain_text(self):
        self.reject("notes.docx", b"just text", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    def test_zip_that_is_not_docx(self):
        self.reject("notes.docx", make_zip_without_word_parts())

    def test_truncated_docx_zip(self):
        self.reject("notes.docx", make_docx()[:200])

    def test_binary_data_named_txt(self):
        self.reject("notes.txt", bytes(range(256)) * 8, "text/plain")
        self.reject("notes.md", b"text\x00with nul bytes", "text/markdown")

    def test_nul_byte_after_first_chunk_is_still_caught(self):
        self.reject("notes.txt", b"a" * (uv.SAMPLE_BYTES + 100) + b"\x00" + b"b" * 50)

    def test_pdf_or_zip_renamed_to_txt(self):
        self.reject("notes.txt", make_pdf(), "text/plain")
        self.reject("notes.md", make_docx())

    def test_pdf_content_with_docx_name_and_docx_with_pdf_name(self):
        self.reject("notes.docx", make_pdf())
        self.reject("notes.pdf", make_docx())

    def test_misleading_content_type_does_not_help(self):
        self.reject("evil.pdf", b"MZ\x90\x00 executable bytes", "application/pdf")
        self.reject("evil.docx", b"<html>hi</html>", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    def test_valid_content_with_wrong_content_type_is_accepted(self):
        # Content-Type is only a hint: the bytes are what count
        self.assertEqual(self.upload("report.pdf", make_pdf(), "text/plain").status_code, 200)
        self.assertEqual(self.upload("n.txt", TXT, "application/pdf").status_code, 200)

    def test_empty_file(self):
        self.reject("empty.txt", b"", expected=uv.MSG_EMPTY_FILE)

    def test_zip_bomb_guard(self):
        with patch.object(uv, "MAX_DOCX_UNCOMPRESSED_BYTES", 10):
            self.reject("big.docx", make_docx())

    def test_corrupt_but_signed_pdf_fails_safely_without_leaking_parser_errors(self):
        res = self.upload("broken.pdf", b"%PDF-1.4\nthis is not a real pdf structure\n%%EOF")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "Invalid file content")
        self.assertEqual(self.doc_count(), 0)

    def test_unreadable_pdf_is_not_leaked_as_exception_text(self):
        with patch.object(RAGService, "extract_document_sync", side_effect=RuntimeError("secret /internal/path")):
            res = self.upload("ok.pdf", make_pdf())
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("secret", res.text)

    def test_unexpected_failure_is_generic_500(self):
        async def boom(**kwargs):
            raise RuntimeError("db exploded at /secret/path")
        with patch.object(rag_service, "process_and_store_document", boom):
            res = self.upload("ok.pdf", make_pdf())
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.json(), {"detail": "Document processing failed"})

    def test_empty_text_document_gets_stable_message(self):
        res = self.upload("blank.txt", b"   \n\n   ")
        self.assertEqual(res.status_code, 400)
        self.assertIn("empty", res.json()["detail"].lower())


class FilenameTests(UploadTestCase):
    def test_path_traversal_filename_is_reduced_to_basename(self):
        for raw in ("../../evil.pdf", "..\\..\\evil.pdf", "/etc/../tmp/evil.pdf", "C:\\Users\\x\\evil.pdf"):
            res = self.upload(raw, make_pdf(text=f"unique content for {len(raw)}"))
            self.assertEqual(res.status_code, 200, raw)
            self.assertEqual(res.json()["filename"], "evil.pdf", raw)
        self.db.expire_all()
        for d in self.db.query(Document).all():
            self.assertNotIn("/", d.filename)
            self.assertNotIn("\\", d.filename)
            self.assertNotIn("..", d.filename)

    def test_path_traversal_with_bad_content_is_still_rejected(self):
        res = self.upload("../../evil.pdf", b"not a pdf")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], uv.MSG_INVALID_CONTENT)

    def test_invalid_filenames(self):
        self.assertEqual(uv.sanitize_filename("a/b/c.pdf"), "c.pdf")
        for raw in ("", None, "..", ".", "dir/", "bad\x00name.pdf", "new\nline.pdf", "x" * 300 + ".pdf"):
            with self.assertRaises(uv.UploadRejected, msg=repr(raw)) as ctx:
                uv.sanitize_filename(raw)
            self.assertEqual(ctx.exception.message, uv.MSG_INVALID_FILENAME)

    def test_misleading_extension_vs_content_in_filename_with_double_extension(self):
        res = self.upload("report.pdf.txt", make_pdf())
        self.assertEqual(res.status_code, 400)  # .txt file whose bytes are a PDF
        self.assertEqual(res.json()["detail"], uv.MSG_INVALID_CONTENT)


class SizeLimitTests(UploadTestCase):
    def txt_of(self, n):
        return (b"word " * (n // 5 + 1))[:n]

    def test_exactly_at_limit_is_accepted(self):
        res = self.upload("limit.txt", self.txt_of(LIMIT))
        self.assertEqual(res.status_code, 200, res.text)

    def test_one_byte_over_limit_is_rejected_before_extraction(self):
        calls = self.spy_extraction()
        res = self.upload("over.txt", self.txt_of(LIMIT + 1))
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json()["detail"], uv.msg_too_large())
        self.assertEqual(calls, [])
        self.assertEqual(self.doc_count(), 0)

    def test_way_over_limit_but_inside_body_allowance_rejected_by_route(self):
        res = self.upload("over.txt", self.txt_of(LIMIT + BODY_OVERHEAD_ALLOWANCE // 2))
        self.assertEqual(res.status_code, 413)

    def test_far_over_limit_rejected_by_middleware_without_reaching_route(self):
        calls = self.spy_extraction()
        # The middleware's own body ("File is too large", no size) proves the route handler never produced the 413
        res = self.upload("huge.txt", self.txt_of(LIMIT + BODY_OVERHEAD_ALLOWANCE + 1000))
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json(), {"detail": "File is too large"})
        self.assertEqual(calls, [])
        self.assertEqual(self.doc_count(), 0)

    def test_oversized_pdf_not_validated_or_parsed(self):
        calls = self.spy_extraction()
        res = self.upload("over.pdf", make_pdf() + b"0" * (LIMIT + 10))
        self.assertEqual(res.status_code, 413)
        self.assertEqual(calls, [])

    def test_signature_checked_before_reading_the_rest(self):
        class Upload:
            size = None
            def __init__(self):
                self.reads = []
            async def read(self, n=-1):
                self.reads.append(n)
                return b"definitely not a pdf" if len(self.reads) == 1 else b"x" * n
        up = Upload()
        with self.assertRaises(uv.UploadRejected) as ctx:
            asyncio.run(uv.read_upload_bounded(up, ".pdf"))
        self.assertEqual(ctx.exception.message, uv.MSG_INVALID_CONTENT)
        self.assertEqual(up.reads, [uv.SAMPLE_BYTES])  # nothing beyond the first chunk was read

    def test_declared_size_rejected_without_reading(self):
        class Upload:
            size = LIMIT + 1
            async def read(self, n=-1):
                raise AssertionError("read() must not be called")
        with self.assertRaises(uv.UploadRejected) as ctx:
            asyncio.run(uv.read_upload_bounded(Upload(), ".txt"))
        self.assertEqual(ctx.exception.status_code, 413)

    def test_streaming_read_stops_at_the_limit(self):
        class Upload:
            size = None
            def __init__(self):
                self.served = 0
            async def read(self, n=-1):
                self.served += n
                return b"a" * n  # endless stream
        up = Upload()
        with self.assertRaises(uv.UploadRejected) as ctx:
            asyncio.run(uv.read_upload_bounded(up, ".txt"))
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertLessEqual(up.served, LIMIT + uv.SAMPLE_BYTES + uv.READ_CHUNK_BYTES)

    def test_limit_is_configurable_with_sane_default(self):
        self.assertEqual(Settings.model_fields["MAX_UPLOAD_SIZE_MB"].default, 10)
        with self.assertRaises(Exception):
            Settings(SECRET_KEY="test-secret-key-for-unit-tests-only", DATABASE_URL="sqlite://", MAX_UPLOAD_SIZE_MB=0)


class StreamingBodyLimitTests(unittest.TestCase):
    """ASGI-level tests with a fake request stream (no giant buffers): chunked body with no Content-Length."""

    def run_asgi(self, chunks, headers, path="/upload"):
        sent = []
        pulled = {"bytes": 0}
        it = iter(chunks)

        async def receive():
            try:
                chunk = next(it)
            except StopIteration:
                return {"type": "http.request", "body": b"", "more_body": False}
            pulled["bytes"] += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": True}

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": path, "headers": headers, "query_string": b"",
                 "client": ("127.0.0.1", 1), "server": ("test", 80), "scheme": "http", "http_version": "1.1",
                 "root_path": "", "app": app}
        asyncio.run(app(scope, receive, send))
        return sent, pulled["bytes"]

    def test_undeclared_length_stream_is_cut_off_at_limit(self):
        chunk = b"x" * 4096
        allowed = LIMIT + BODY_OVERHEAD_ALLOWANCE
        prelude = (b'--abc\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n'
                   b'Content-Type: text/plain\r\n\r\n')
        def stream():
            yield prelude
            for _ in range(10_000):                 # would be ~40 MB if fully consumed
                yield chunk
        endless = stream()
        with patch.object(settings, "MAX_UPLOAD_SIZE_MB", TEST_LIMIT_MB):
            sent, pulled = self.run_asgi(
                endless, [(b"content-type", b"multipart/form-data; boundary=abc"), (b"transfer-encoding", b"chunked")]
            )
        start = next(m for m in sent if m["type"] == "http.response.start")
        self.assertEqual(start["status"], 413)
        self.assertLessEqual(pulled, allowed + len(chunk))

    def test_declared_oversize_rejected_without_reading_any_body(self):
        def never():
            raise AssertionError("body must not be read")
            yield
        with patch.object(settings, "MAX_UPLOAD_SIZE_MB", TEST_LIMIT_MB):
            sent, pulled = self.run_asgi(
                never(), [(b"content-length", str(LIMIT + BODY_OVERHEAD_ALLOWANCE + 1).encode()),
                          (b"content-type", b"multipart/form-data; boundary=abc")]
            )
        self.assertEqual(next(m for m in sent if m["type"] == "http.response.start")["status"], 413)
        self.assertEqual(pulled, 0)

    def test_other_paths_are_not_limited(self):
        big = [b"x" * 4096] * 100
        with patch.object(settings, "MAX_UPLOAD_SIZE_MB", 0.0001):
            sent, pulled = self.run_asgi(big, [(b"content-type", b"application/json")], path="/health")
        self.assertNotEqual(next(m for m in sent if m["type"] == "http.response.start")["status"], 413)


class ExistingBehaviorTests(UploadTestCase):
    def test_duplicate_upload_is_deduplicated_and_skips_extraction(self):
        first = self.upload("a.txt", TXT)
        calls = self.spy_extraction()
        second = self.upload("renamed.txt", TXT)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(self.doc_count(), 1)
        self.assertEqual(calls, [])

    def test_extraction_runs_once_for_a_valid_upload(self):
        calls = self.spy_extraction()
        self.assertEqual(self.upload("a.txt", TXT).status_code, 200)
        self.assertEqual(len(calls), 1)

    def test_same_document_in_two_chats(self):
        a, b = self._chat(), self._chat()
        d1 = self.upload("a.pdf", make_pdf(), chat_id=a.id).json()["id"]
        d2 = self.upload("a.pdf", make_pdf(), chat_id=b.id).json()["id"]
        self.assertEqual(d1, d2)
        self.assertEqual(self.doc_count(), 1)
        for chat in (a, b):
            self.assertEqual([d.id for d in rag_service.get_chat_documents(self.db, chat.id, self.user.id)], [d1])
        rows = self.db.execute(chat_documents.select()).all()
        self.assertEqual(len(rows), 2)

    def test_ownership_and_isolation(self):
        chat = self._chat()
        doc_id = self.upload("a.txt", TXT, chat_id=chat.id).json()["id"]
        # Another user uploading identical bytes gets their own document, not the first user's
        self.current = self.other
        other_id = self.upload("a.txt", TXT).json()["id"]
        self.assertNotEqual(doc_id, other_id)
        self.assertEqual(rag_service.get_chat_documents(self.db, chat.id, self.other.id), [])
        chunks = asyncio.run(rag_service.retrieve_relevant_chunks("project", self.other.id, chat_id=chat.id, db=self.db))
        self.assertEqual(chunks, [])
        self.db.expire_all()
        self.assertEqual(self.db.get(Document, doc_id).user_id, self.user.id)

    def test_unauthenticated_upload_still_rejected(self):
        app.dependency_overrides.pop(get_current_user)
        res = TestClient(app).post("/upload", files={"file": ("a.txt", TXT)})
        self.assertEqual(res.status_code, 401)

    def test_413_response_carries_cors_headers_for_the_frontend(self):
        res = self.client.post(
            "/upload", files={"file": ("huge.txt", b"w" * (LIMIT + BODY_OVERHEAD_ALLOWANCE + 1000))},
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.headers.get("access-control-allow-origin"), "http://localhost:3000")


if __name__ == "__main__":
    unittest.main()
