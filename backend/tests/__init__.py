"""
Backend regression tests (stdlib unittest). Run from backend/:  venv/bin/python -m unittest discover -s tests -t . -v

Environment is pointed at a throwaway SQLite file BEFORE any app module is imported, so the real lumina.db is never touched.
"""
import atexit
import os
import tempfile

_tmp_dir = tempfile.mkdtemp(prefix="lumina-tests-")
os.environ["DATABASE_URL"] = f"sqlite:///{os.path.join(_tmp_dir, 'test.db')}"
os.environ.setdefault("SECRET_KEY", "test-secret-key-for-unit-tests-only")
os.environ["KOKORO_POOL_TIMEOUT"] = "0.2"


@atexit.register
def _cleanup():
    import shutil
    shutil.rmtree(_tmp_dir, ignore_errors=True)
