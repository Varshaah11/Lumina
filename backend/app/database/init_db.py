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
    except Exception as e:
        logger.error(f"Schema migration error: {e}")

def init_db():
    logger.info("Initializing database...")
    Base.metadata.create_all(bind=engine)
    migrate_schema()
    logger.info("Database initialized successfully.")
