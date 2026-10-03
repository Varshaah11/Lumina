from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.core.config import settings


def enable_sqlite_foreign_keys(target_engine: Engine) -> None:
    """
    Makes every SQLite connection of `target_engine` enforce foreign keys (PRAGMA foreign_keys=ON).
    SQLite ignores FOREIGN KEY / ON DELETE CASCADE unless this is set per connection, and the setting cannot be changed
    inside a transaction, so it is applied in the connect event, before the connection is used. Other databases are left alone.
    """
    if target_engine.dialect.name != "sqlite":
        return

    @event.listens_for(target_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


engine = create_engine(
    settings.DATABASE_URL, connect_args={"check_same_thread": False}
)
enable_sqlite_foreign_keys(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()
