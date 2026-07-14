from datetime import datetime
from typing import TYPE_CHECKING
from sqlalchemy import String, DateTime, ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func
from app.database.database import Base

if TYPE_CHECKING:
    from app.models.chat import Chat

class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    chat_id: Mapped[int] = mapped_column(Integer, ForeignKey("chats.id"))
    role: Mapped[str] = mapped_column(String(50)) # 'user' or 'assistant'
    content: Mapped[str] = mapped_column(Text)
    
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    chat: Mapped["Chat"] = relationship("Chat", back_populates="messages")
