"""
Alembic environment. Two entry points share it:
- the application (app/database/migrations.py) passes an open connection in config.attributes["connection"];
- the alembic CLI, which connects to settings.DATABASE_URL.
render_as_batch is on because SQLite can only change most table definitions by rebuilding the table.
"""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.database.database import Base
import app.models.chat  # noqa: F401  (register every model on Base.metadata)
import app.models.document  # noqa: F401
import app.models.message  # noqa: F401
import app.models.user  # noqa: F401

config = context.config
target_metadata = Base.metadata


def run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        run_migrations(connection)
        return

    # CLI use: configure logging from alembic.ini (the application keeps its own logging setup)
    if config.config_file_name is not None:
        fileConfig(config.config_file_name)
    from app.database.migrations import migration_connection
    from app.core.config import settings

    engine = create_engine(settings.DATABASE_URL)
    try:
        with migration_connection(engine) as connection:
            run_migrations(connection)
            connection.commit()  # the connection is already in a transaction, so Alembic leaves the commit to us
    finally:
        engine.dispose()


def run_migrations_offline() -> None:
    from app.core.config import settings

    context.configure(url=settings.DATABASE_URL, target_metadata=target_metadata, literal_binds=True,
                      render_as_batch=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
