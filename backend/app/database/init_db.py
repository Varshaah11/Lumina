import logging
from app.database.database import engine, Base
# Import all models here to ensure Base.metadata.create_all can discover them
from app.models.user import User
from app.models.chat import Chat
from app.models.message import Message
from app.models.document import Document, DocumentChunk

from sqlalchemy import inspect, text

logger = logging.getLogger(__name__)

def migrate_schema():
    """Safely adds new columns to existing SQLite tables if not present."""
    try:
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        if "users" in tables:
            columns = [col["name"] for col in inspector.get_columns("users")]
            with engine.connect() as conn:
                if "location" not in columns:
                    logger.info("Migrating users table: adding location column")
                    conn.execute(text("ALTER TABLE users ADD COLUMN location VARCHAR(255)"))
                if "bio" not in columns:
                    logger.info("Migrating users table: adding bio column")
                    conn.execute(text("ALTER TABLE users ADD COLUMN bio TEXT"))
                conn.commit()

            # Normalize legacy emails to trimmed lowercase (skip any that would collide with another account),
            # then enforce case-insensitive uniqueness at the database level.
            with engine.connect() as conn:
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
        # chat_documents is created by create_all(); only backfill while it is still empty.
        if "documents" in tables:
            doc_columns = [col["name"] for col in inspector.get_columns("documents")]
            if "chat_id" in doc_columns:
                with engine.connect() as conn:
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
    except Exception as e:
        logger.error(f"Schema migration error: {e}")

def init_db():
    logger.info("Initializing database...")
    Base.metadata.create_all(bind=engine)
    migrate_schema()
    logger.info("Database initialized successfully.")
