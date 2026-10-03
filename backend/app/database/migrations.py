"""
Schema versioning with Alembic (revisions live in backend/migrations/versions/).

upgrade_database() runs at startup and handles every kind of database:
- empty (new install, or tables dropped by the tests): built from the revisions;
- created before Alembic was introduced (application tables but no alembic_version table): brought to the baseline by
  the original idempotent migrate_schema() steps, stamped as the baseline revision, then upgraded;
- already versioned: upgraded to the latest revision (a no-op when it is current).

Migrations run with SQLite foreign-key enforcement switched off, as SQLite requires for table rebuilds: with it on,
rebuilding a table (DROP + rename) would cascade-delete the rows that reference it. A foreign_key_check before and
after makes sure a migration never leaves new dangling references; if it would, the whole upgrade is rolled back.
"""
import logging
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"
BASELINE_REVISION = "0001"
VERSION_TABLE = "alembic_version"


def alembic_config(connection: Connection | None = None) -> Config:
    config = Config(str(ALEMBIC_INI))
    if connection is not None:
        config.attributes["connection"] = connection
    return config


@contextmanager
def migration_connection(engine: Engine):
    """A connection with SQLite foreign-key enforcement off for the duration of a migration, restored afterwards."""
    sqlite = engine.dialect.name == "sqlite"
    with engine.connect() as connection:
        if sqlite:
            # Must be issued outside a transaction to take effect (pysqlite only opens one for DML)
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            yield connection
        finally:
            if sqlite:
                connection.rollback()
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")


def _foreign_key_violations(connection: Connection) -> int:
    if connection.dialect.name != "sqlite":
        return 0
    return len(connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall())


def _has_index(engine: Engine, name: str) -> bool:
    # Looked up in sqlite_master: SQLAlchemy's inspector skips expression-based indexes such as lower(email)
    with engine.connect() as connection:
        return connection.exec_driver_sql("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)).first() is not None


def _require_baseline(engine: Engine, base) -> None:
    """Refuse to stamp a pre-Alembic database as the baseline unless the legacy steps really got it there."""
    inspector = inspect(engine)
    missing = []
    for table in base.metadata.sorted_tables:
        present = {c["name"] for c in inspector.get_columns(table.name)}
        missing += [f"{table.name}.{c.name}" for c in table.columns if c.name not in present]
    if not _has_index(engine, "ix_users_email_lower"):
        # As before migrations existed: duplicate case-variant e-mails block this index; the app still runs, loudly
        logger.warning("Case-insensitive unique e-mail index is missing (case-variant duplicate e-mails exist?)")
    if missing:
        raise RuntimeError(f"Database could not be brought to the baseline schema; missing: {', '.join(missing)}")


def upgrade_database(engine: Engine) -> None:
    # Imported here: init_db imports this module, and migrate_schema lives in init_db
    from app.database.database import Base
    from app.database.init_db import migrate_schema

    tables = set(inspect(engine).get_table_names())
    app_tables = set(Base.metadata.tables)
    pre_alembic = bool(tables & app_tables) and VERSION_TABLE not in tables

    if not tables & app_tables and VERSION_TABLE in tables:
        # Version marker without any application table (the tests drop all tables between cases): start over
        with engine.begin() as connection:
            connection.exec_driver_sql(f"DROP TABLE {VERSION_TABLE}")
    if pre_alembic:
        logger.info("Database predates migrations: applying the legacy upgrade steps and stamping the baseline")
        # Exactly what startup did before Alembic: create any missing table (e.g. chat_documents), then the legacy steps
        Base.metadata.create_all(bind=engine)
        migrate_schema(engine)
        _require_baseline(engine, Base)

    with migration_connection(engine) as connection:
        before = _foreign_key_violations(connection)
        config = alembic_config(connection)
        if pre_alembic:
            command.stamp(config, BASELINE_REVISION)
        command.upgrade(config, "head")
        after = _foreign_key_violations(connection)
        if after > before:
            connection.rollback()
            raise RuntimeError(f"Database migration aborted: it would leave {after - before} new foreign key violation(s)")
        connection.commit()
