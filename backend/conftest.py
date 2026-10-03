"""
pytest bootstrap for the backend test suite.

1. Before any application module is imported, point DATABASE_URL at a throwaway SQLite file (the app reads its settings
   once, at import time). tests/__init__.py does the same for plain `python -m unittest`, and may replace this URL with
   its own throwaway file; either way the database is temporary.
2. After collection, when the app engine really exists, verify it is a throwaway SQLite database and abort the whole
   run otherwise. The real backend/lumina.db must never be touched by tests.
"""
import atexit
import os
import shutil
import tempfile
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent
REAL_DATABASE = (BACKEND_DIR / "lumina.db").resolve()
TEMP_DIR_PREFIXES = ("lumina-pytest-", "lumina-tests-")  # this file, tests/__init__.py

_tmp_dir = tempfile.mkdtemp(prefix="lumina-pytest-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmp_dir, 'test.db')}"
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")
os.environ["KOKORO_POOL_TIMEOUT"] = "0.2"
atexit.register(shutil.rmtree, _tmp_dir, ignore_errors=True)


def _unsafe_database_reason(url) -> str | None:
    """Why `url` must not be used by tests, or None when it is a throwaway SQLite file."""
    if url.get_backend_name() != "sqlite":
        return f"backend {url.get_backend_name()!r} is not SQLite"
    if not url.database or url.database == ":memory:":
        return None
    path = Path(url.database).resolve()
    if path == REAL_DATABASE:
        return "it is the real backend/lumina.db"
    if not path.parent.name.startswith(TEMP_DIR_PREFIXES):
        return f"{path} is not inside a test temp directory"
    return None


def pytest_collection_finish(session):
    # Test modules (and therefore the app's settings and engine) are imported during collection.
    from app.database.database import engine

    reason = _unsafe_database_reason(engine.url)
    if reason:
        pytest.exit(f"Refusing to run tests: the application database is unsafe ({reason}).", returncode=3)
