import logging
from app.database.database import engine, Base
# Import all models here to ensure Base.metadata.create_all can discover them
from app.models.user import User
from app.models.chat import Chat
from app.models.message import Message

logger = logging.getLogger(__name__)

def init_db():
    logger.info("Initializing database...")
    Base.metadata.create_all(bind=engine)
    logger.info("Database initialized successfully.")
