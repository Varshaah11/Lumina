"""
Upload validation helpers: filename sanitizing, size limit and content (signature) checks for the supported formats.

Filename and Content-Type are only hints. For every supported format the actual bytes must match, and all checks run
before extraction, chunking, embedding or any database write.
"""
import io
import os
import re
import zipfile
from typing import Tuple

from app.core.config import settings

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}
SAMPLE_BYTES = 8192                       # leading bytes inspected by the signature checks
READ_CHUNK_BYTES = 1024 * 1024
MAX_FILENAME_LENGTH = 255                 # matches documents.filename column
MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024   # zip-bomb guard (docx is a zip container)
MAX_DOCX_ENTRIES = 10_000
PDF_HEADER_WINDOW = 1024                  # PDF spec lets "%PDF-" appear within the first 1024 bytes

MSG_INVALID_FILENAME = "Invalid filename"
MSG_UNSUPPORTED_TYPE = "Unsupported file type. Allowed types: PDF, DOCX, TXT, MD"
MSG_INVALID_CONTENT = "Invalid file content"
MSG_EMPTY_FILE = "File is empty"


def max_upload_bytes() -> int:
    return int(settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024)


def msg_too_large() -> str:
    return f"File is too large (maximum {settings.MAX_UPLOAD_SIZE_MB:g} MB)"


class UploadRejected(Exception):
    """A client-side upload problem with a stable, user-safe message."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def sanitize_filename(raw: str | None) -> str:
    """Returns a bare file name (no directories). Rejects empty names and control characters."""
    if not raw or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise UploadRejected(400, MSG_INVALID_FILENAME)
    name = raw.replace("\\", "/").split("/")[-1].strip()
    if name in ("", ".", "..") or len(name) > MAX_FILENAME_LENGTH:
        raise UploadRejected(400, MSG_INVALID_FILENAME)
    return name


def get_extension(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise UploadRejected(400, MSG_UNSUPPORTED_TYPE)
    return ext


def _looks_like_text(sample: bytes) -> bool:
    if b"\x00" in sample:
        return False
    # Binary container signatures are never valid plain text/markdown
    if sample.startswith((b"%PDF-", b"PK\x03\x04", b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"MZ", b"\x7fELF")):
        return False
    if not sample:
        return True
    control = sum(1 for b in sample if b < 32 and b not in (9, 10, 12, 13))
    return control / len(sample) <= 0.05


def check_header(ext: str, head: bytes) -> None:
    """Cheap signature check on the first bytes only. Raises UploadRejected on a mismatch."""
    if not head:
        raise UploadRejected(400, MSG_EMPTY_FILE)
    if ext == ".pdf":
        ok = b"%PDF-" in head[:PDF_HEADER_WINDOW]
    elif ext == ".docx":
        ok = head.startswith(b"PK\x03\x04")
    else:  # .txt / .md
        ok = _looks_like_text(head)
    if not ok:
        raise UploadRejected(400, MSG_INVALID_CONTENT)


def check_full_content(ext: str, data: bytes) -> None:
    """Checks that need the whole (already size-bounded) file: docx structure, NUL bytes in text files."""
    if ext == ".docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                infos = zf.infolist()
                names = {i.filename for i in infos}
                total = sum(i.file_size for i in infos)
        except (zipfile.BadZipFile, ValueError, OSError):
            raise UploadRejected(400, MSG_INVALID_CONTENT)
        if (
            "[Content_Types].xml" not in names
            or "word/document.xml" not in names
            or len(infos) > MAX_DOCX_ENTRIES
            or total > MAX_DOCX_UNCOMPRESSED_BYTES
        ):
            raise UploadRejected(400, MSG_INVALID_CONTENT)
    elif ext in {".txt", ".md"}:
        if b"\x00" in data:
            raise UploadRejected(400, MSG_INVALID_CONTENT)


async def read_upload_bounded(upload, ext: str) -> bytes:
    """
    Reads an UploadFile in chunks, never holding more than the limit (+1 chunk) in memory:
      * rejects on the declared size before reading anything,
      * validates the file signature on the first chunk before reading the rest,
      * aborts as soon as the running total exceeds the limit.
    """
    limit = max_upload_bytes()
    declared = getattr(upload, "size", None)
    if declared is not None and declared > limit:
        raise UploadRejected(413, msg_too_large())

    first = await upload.read(SAMPLE_BYTES)
    check_header(ext, first)

    buf = bytearray(first)
    while True:
        chunk = await upload.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            raise UploadRejected(413, msg_too_large())
    if len(buf) > limit:
        raise UploadRejected(413, msg_too_large())
    return bytes(buf)
