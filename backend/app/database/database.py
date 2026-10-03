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


# SQLite stores INTEGER keys as signed 64-bit values: no row can have an id outside this range, and binding such a
# Python int to a query raises OverflowError instead of simply matching nothing.
SQLITE_INTEGER_MIN = -(2 ** 63)
SQLITE_INTEGER_MAX = 2 ** 63 - 1


def fits_sqlite_integer(value: int) -> bool:
    """True when `value` can be stored in (and therefore looked up as) a SQLite INTEGER column."""
    return SQLITE_INTEGER_MIN <= value <= SQLITE_INTEGER_MAX


# hide_parameters: database errors reach the server log; their bound values (e-mails, password hashes, chat text) must not
engine = create_engine(
    settings.DATABASE_URL, connect_args={"check_same_thread": False}, hide_parameters=True
)
enable_sqlite_foreign_keys(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()
