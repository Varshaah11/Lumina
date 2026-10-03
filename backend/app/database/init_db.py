import logging
from app.database.database import engine
# Import all models here so they are registered on Base.metadata
from app.models.user import User  # noqa: F401
from app.models.chat import Chat  # noqa: F401
from app.models.message import Message  # noqa: F401
from app.models.document import Document, DocumentChunk  # noqa: F401

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

def migrate_schema(target_engine: Engine | None = None):
    """
    Brings a database created before Alembic up to the baseline revision: adds missing columns/indexes and backfills
    data. Every step is idempotent and non-destructive. Run by upgrade_database() only for such databases (which are
    then stamped); schema changes after the baseline are Alembic revisions in backend/migrations/versions/.
    Defaults to the application engine; tests pass their own.
    """
    eng = target_engine or engine
    try:
        inspector = inspect(eng)
        tables = inspector.get_table_names()
        if "users" in tables:
            columns = [col["name"] for col in inspector.get_columns("users")]
            with eng.connect() as conn:
                if "location" not in columns:
                    logger.info("Migrating users table: adding location column")
                    conn.execute(text("ALTER TABLE users ADD COLUMN location VARCHAR(255)"))
                if "bio" not in columns:
                    logger.info("Migrating users table: adding bio column")
                    conn.execute(text("ALTER TABLE users ADD COLUMN bio TEXT"))
                conn.commit()

            # Normalize legacy emails to trimmed lowercase (skip any that would collide with another account),
            # then enforce case-insensitive uniqueness at the database level.
            with eng.connect() as conn:
                conn.execute(text(
                    "UPDATE users SET email = lower(trim(email)) "
                    "WHERE email != lower(trim(email)) "
                    "AND (SELECT COUNT(*) FROM users u2 WHERE lower(trim(u2.email)) = lower(trim(users.email))) = 1"
                ))
                conn.commit()
                try:
                    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_lower ON users (lower(email))"))
                    conn.commit()
                except Exception as idx_err:
                    conn.rollback()
                    logger.warning(f"Could not create case-insensitive unique email index (duplicate emails exist?): {idx_err}")

        # Backfill chat<->document links from the legacy documents.chat_id column.
        # chat_documents already exists (created with the other tables); only backfill while it is still empty.
        if "documents" in tables:
            doc_columns = [col["name"] for col in inspector.get_columns("documents")]
            if "chat_id" in doc_columns:
                with eng.connect() as conn:
                    link_count = conn.execute(text("SELECT COUNT(*) FROM chat_documents")).scalar()
                    if not link_count:
                        result = conn.execute(text(
                            "INSERT OR IGNORE INTO chat_documents (chat_id, document_id) "
                            "SELECT d.chat_id, d.id FROM documents d "
                            "WHERE d.chat_id IS NOT NULL AND d.chat_id IN (SELECT id FROM chats)"
                        ))
                        if result.rowcount:
                            logger.info(f"Migrated {result.rowcount} legacy document-chat links into chat_documents")
                    conn.commit()

                # Foreign keys are now enforced (see database.py). The legacy documents.chat_id column still carries
                # "ON DELETE CASCADE" in existing databases, so deleting a chat would also delete a document that other
                # chats share. The relationship now lives in chat_documents; clear the legacy reference once it is
                # safely recorded there (only where the matching link row exists, so no information is lost).
                with eng.connect() as conn:
                    cleared = conn.execute(text(
                        "UPDATE documents SET chat_id = NULL WHERE chat_id IS NOT NULL AND EXISTS ("
                        "SELECT 1 FROM chat_documents cd WHERE cd.document_id = documents.id AND cd.chat_id = documents.chat_id)"
                    ))
                    if cleared.rowcount:
                        logger.info(f"Cleared {cleared.rowcount} legacy documents.chat_id references (now in chat_documents)")
                    conn.commit()

        # Messages are always read by chat: index messages.chat_id (matches the model's index=True name)
        if "messages" in tables:
            with eng.connect() as conn:
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_chat_id ON messages (chat_id)"))
                conn.commit()
    except Exception as e:
        logger.error(f"Schema migration error: {e}")

def init_db():
    from app.database.migrations import upgrade_database

    logger.info("Initializing database...")
    upgrade_database(engine)
    logger.info("Database initialized successfully.")
