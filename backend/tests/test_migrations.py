"""
Alembic schema migrations (backend/migrations, app/database/migrations.py): a fresh database is built from the
revisions and matches the models; a database created before migrations existed is brought to the baseline, stamped
and keeps every row; upgrades are repeatable; the application starts on a migrated database; the baseline downgrade
works; and a migration may never leave new foreign-key violations behind. Every database here is a temporary file.
"""
import sqlite3
import warnings

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

import app.database.migrations as migrations
from app.database.database import Base, enable_sqlite_foreign_keys
from app.database.init_db import migrate_schema
from app.database.migrations import BASELINE_REVISION, alembic_config, migration_connection, upgrade_database

APP_TABLES = {"users", "chats", "messages", "documents", "document_chunks", "chat_documents"}


@pytest.fixture
def make_engine(tmp_path):
    engines = []

    def _make(name="db.sqlite"):
        eng = create_engine(f"sqlite:///{tmp_path / name}", connect_args={"check_same_thread": False})
        enable_sqlite_foreign_keys(eng)
        engines.append(eng)
        return eng

    yield _make
    for eng in engines:
        eng.dispose()


def schema(eng):
    """Every table/index definition except the version table, as SQLite stores it."""
    with eng.connect() as conn:
        return conn.exec_driver_sql(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'alembic_version' "
            "ORDER BY type, name").fetchall()


def version(eng):
    with eng.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def head():
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def model_drift(eng):
    with eng.connect() as conn, warnings.catch_warnings():
        # The lower(email) index is expression-based: SQLAlchemy cannot reflect it and says so; it is checked directly
        warnings.filterwarnings("ignore", message="Skipped unsupported reflection of expression-based index")
        return compare_metadata(MigrationContext.configure(conn), Base.metadata)


def rows(eng, table):
    with eng.connect() as conn:
        return conn.exec_driver_sql(f"SELECT * FROM {table} ORDER BY rowid").fetchall()


# ---------------------------------------------------------------- revision graph
def test_there_is_exactly_one_head_and_the_baseline_is_its_root():
    script = ScriptDirectory.from_config(alembic_config())
    assert len(script.get_heads()) == 1
    assert [rev.revision for rev in script.walk_revisions()][-1] == BASELINE_REVISION


# ---------------------------------------------------------------- fresh database
def test_fresh_database_is_built_from_the_revisions_and_matches_the_models(make_engine):
    eng = make_engine()
    upgrade_database(eng)
    assert version(eng) == head()
    assert set(inspect(eng).get_table_names()) == APP_TABLES | {"alembic_version"}
    assert model_drift(eng) == []


def test_fresh_schema_is_identical_to_the_pre_migration_startup_schema(make_engine):
    """create_all() + migrate_schema() was how startup built a database before Alembic: same tables, same indexes."""
    migrated, legacy = make_engine("migrated.db"), make_engine("legacy.db")
    upgrade_database(migrated)
    Base.metadata.create_all(bind=legacy)
    migrate_schema(legacy)
    assert schema(migrated) == schema(legacy)


def test_case_insensitive_email_uniqueness_is_part_of_the_baseline(make_engine):
    eng = make_engine()
    upgrade_database(eng)
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO users (name, email, hashed_password) VALUES ('a', 'sam@example.com', 'x')"))
    with pytest.raises(Exception), eng.begin() as conn:
        conn.execute(text("INSERT INTO users (name, email, hashed_password) VALUES ('b', 'SAM@example.com', 'x')"))


# ---------------------------------------------------------------- database created before migrations
def build_pre_migration_database(eng):
    """An early Lumina database (tables and indexes as create_all made them back then): no profile columns, no
    chat_documents table, no case-insensitive e-mail index, no messages.chat_id index, documents linked by documents.chat_id."""
    with eng.begin() as conn:
        for stmt in [
            "CREATE TABLE users (id INTEGER NOT NULL, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL, "
            "hashed_password VARCHAR(255) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, "
            "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY (id))",
            "CREATE UNIQUE INDEX ix_users_email ON users (email)",
            "CREATE INDEX ix_users_id ON users (id)",
            "CREATE INDEX ix_users_name ON users (name)",
            "CREATE TABLE chats (id INTEGER NOT NULL, title VARCHAR(255) NOT NULL, user_id INTEGER NOT NULL, "
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, "
            "PRIMARY KEY (id), FOREIGN KEY(user_id) REFERENCES users (id))",
            "CREATE INDEX ix_chats_id ON chats (id)",
            "CREATE INDEX ix_chats_title ON chats (title)",
            "CREATE TABLE messages (id INTEGER NOT NULL, chat_id INTEGER NOT NULL, role VARCHAR(50) NOT NULL, "
            "content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY (id), "
            "FOREIGN KEY(chat_id) REFERENCES chats (id))",
            "CREATE INDEX ix_messages_id ON messages (id)",
            "CREATE TABLE documents (id INTEGER NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER, "
            "filename VARCHAR(255) NOT NULL, file_type VARCHAR(50) NOT NULL, file_hash VARCHAR(64) NOT NULL, "
            "char_count INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY (id), "
            "FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, FOREIGN KEY(chat_id) REFERENCES chats (id) ON DELETE CASCADE)",
            "CREATE INDEX ix_documents_chat_id ON documents (chat_id)",
            "CREATE INDEX ix_documents_id ON documents (id)",
            "CREATE INDEX ix_documents_user_id ON documents (user_id)",
            "CREATE INDEX ix_documents_filename ON documents (filename)",
            "CREATE INDEX ix_documents_file_hash ON documents (file_hash)",
            "CREATE TABLE document_chunks (id INTEGER NOT NULL, document_id INTEGER NOT NULL, chunk_index INTEGER NOT NULL, "
            "page_number INTEGER, content TEXT NOT NULL, embedding_json TEXT NOT NULL, "
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, PRIMARY KEY (id), "
            "FOREIGN KEY(document_id) REFERENCES documents (id) ON DELETE CASCADE)",
            "CREATE INDEX ix_document_chunks_id ON document_chunks (id)",
            "CREATE INDEX ix_document_chunks_document_id ON document_chunks (document_id)",
            "INSERT INTO users (id, name, email, hashed_password) VALUES (1, 'Sam', ' Sam@Example.COM ', 'h'), (2, 'Ana', 'ana@example.com', 'h')",
            "INSERT INTO chats (id, title, user_id) VALUES (10, 'Rivers', 1), (11, 'Lakes', 1), (12, 'Ana chat', 2)",
            "INSERT INTO messages (id, chat_id, role, content) VALUES (1, 10, 'user', 'hi'), (2, 10, 'assistant', 'hello'), (3, 12, 'user', 'q')",
            "INSERT INTO documents (id, user_id, chat_id, filename, file_type, file_hash, char_count) "
            "VALUES (100, 1, 10, 'notes.txt', 'txt', 'h1', 5), (101, 1, NULL, 'loose.txt', 'txt', 'h2', 5)",
            "INSERT INTO document_chunks (id, document_id, chunk_index, content, embedding_json) VALUES (1000, 100, 0, 'chunk', '[0.1]')",
        ]:
            conn.exec_driver_sql(stmt)


def test_pre_migration_database_is_brought_to_the_baseline_and_keeps_every_row(make_engine):
    eng = make_engine()
    build_pre_migration_database(eng)
    messages, chunks = rows(eng, "messages"), rows(eng, "document_chunks")

    upgrade_database(eng)

    assert version(eng) == head()
    assert rows(eng, "messages") == messages
    assert rows(eng, "document_chunks") == chunks
    assert [r[0] for r in rows(eng, "chats")] == [10, 11, 12]
    columns = {c["name"] for c in inspect(eng).get_columns("users")}
    assert {"location", "bio"} <= columns
    with eng.connect() as conn:
        assert conn.exec_driver_sql("SELECT email FROM users WHERE id = 1").scalar() == "sam@example.com"
        assert conn.exec_driver_sql("SELECT chat_id, document_id FROM chat_documents").fetchall() == [(10, 100)]
        # the legacy reference is cleared once the link is recorded in chat_documents
        assert conn.exec_driver_sql("SELECT chat_id FROM documents WHERE id = 100").scalar() is None
        assert conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
    # Only the documented legacy leftovers differ from the models: documents.chat_id (with its index and foreign key)
    # and users.bio added as TEXT by ALTER TABLE (the model says VARCHAR; SQLite treats both as text)
    drift = {d[0] if isinstance(d, tuple) else d[0][0] for d in model_drift(eng)}
    assert drift <= {"remove_column", "remove_index", "remove_fk", "modify_type"}
    assert "ix_messages_chat_id" in {i["name"] for i in inspect(eng).get_indexes("messages")}
    assert migrations._has_index(eng, "ix_users_email_lower")


def test_pre_migration_database_that_already_matches_the_baseline_is_only_stamped(make_engine):
    eng = make_engine()
    Base.metadata.create_all(bind=eng)
    migrate_schema(eng)
    before = schema(eng)
    upgrade_database(eng)
    assert version(eng) == BASELINE_REVISION == head()
    assert schema(eng) == before


def test_pre_migration_database_that_cannot_reach_the_baseline_is_not_stamped(make_engine, monkeypatch):
    eng = make_engine()
    build_pre_migration_database(eng)
    monkeypatch.setattr("app.database.init_db.migrate_schema", lambda target_engine=None: None)  # legacy steps "fail"
    with pytest.raises(RuntimeError, match="users.location"):
        upgrade_database(eng)
    assert "alembic_version" not in inspect(eng).get_table_names()


# ---------------------------------------------------------------- repeatability
def test_repeated_upgrades_change_nothing(make_engine):
    eng = make_engine()
    build_pre_migration_database(eng)
    upgrade_database(eng)
    snapshot = (schema(eng), rows(eng, "users"), rows(eng, "chat_documents"), version(eng))
    upgrade_database(eng)
    upgrade_database(eng)
    assert (schema(eng), rows(eng, "users"), rows(eng, "chat_documents"), version(eng)) == snapshot


def test_version_marker_without_tables_is_rebuilt_from_scratch(make_engine):
    """The test suites drop every table between cases; the stale version row must not leave the database empty."""
    eng = make_engine()
    upgrade_database(eng)
    Base.metadata.drop_all(bind=eng)
    upgrade_database(eng)
    assert APP_TABLES <= set(inspect(eng).get_table_names())
    assert version(eng) == head()


def test_foreign_key_enforcement_is_restored_after_migrating(make_engine):
    eng = make_engine()
    upgrade_database(eng)
    with eng.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1


# ---------------------------------------------------------------- safety net
def test_a_migration_that_would_leave_dangling_references_is_rolled_back(make_engine, monkeypatch):
    eng = make_engine()
    upgrade_database(eng)
    real_upgrade = command.upgrade

    def broken_upgrade(config, revision):
        real_upgrade(config, revision)
        config.attributes["connection"].exec_driver_sql(
            "INSERT INTO messages (chat_id, role, content) VALUES (999, 'user', 'orphan')")

    monkeypatch.setattr(migrations.command, "upgrade", broken_upgrade)
    with pytest.raises(RuntimeError, match="foreign key"):
        upgrade_database(eng)
    assert rows(eng, "messages") == []


def test_migration_connection_disables_foreign_keys_only_while_migrating(make_engine):
    eng = make_engine()
    upgrade_database(eng)
    with migration_connection(eng) as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 0
    with eng.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1


# ---------------------------------------------------------------- downgrade
def test_baseline_downgrade_removes_the_schema_and_upgrade_rebuilds_it(make_engine):
    eng = make_engine()
    upgrade_database(eng)
    with migration_connection(eng) as conn:
        command.downgrade(alembic_config(conn), "base")
        conn.commit()
    assert set(inspect(eng).get_table_names()) <= {"alembic_version"}
    assert version(eng) is None
    upgrade_database(eng)
    assert version(eng) == head() and model_drift(eng) == []


# ---------------------------------------------------------------- the application on a migrated database
def test_application_starts_and_serves_on_a_migrated_database(db_session):
    """The app's own startup (lifespan -> init_db -> upgrade_database) on the test database, then real requests."""
    from fastapi.testclient import TestClient

    from app.database.database import engine
    from app.main import app

    with TestClient(app) as client:          # runs the startup handler
        assert version(engine) == head()
        res = client.post("/auth/register", json={"name": "Migrated", "email": "m@example.com", "password": "password123"})
        assert res.status_code == 201
        assert client.get("/health").json()["database"] == "healthy"


def test_real_database_file_is_never_used_here():
    from app.database.database import engine

    assert "lumina.db" not in str(engine.url)
    assert sqlite3.sqlite_version  # the stdlib driver backs every engine above


# ---------------------------------------------------------------- the alembic command line (migrations/env.py CLI path)
def test_alembic_cli_upgrades_checks_and_downgrades_a_database(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{tmp_path / 'cli.db'}", "SECRET_KEY": "cli-test-secret-key-not-a-real-one-000"}

    def alembic(*args):
        return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=backend, env=env, capture_output=True, text=True)

    assert alembic("upgrade", "head").returncode == 0
    current = alembic("current")
    assert current.returncode == 0 and f"{BASELINE_REVISION} (head)" in current.stdout
    check = alembic("check")                      # models and revisions agree: nothing left to autogenerate
    assert check.returncode == 0, check.stderr
    assert alembic("downgrade", "base").returncode == 0
    assert "(head)" not in alembic("current").stdout
