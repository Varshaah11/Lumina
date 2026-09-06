from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="The message from the user to the AI.")
    chat_id: Optional[int] = Field(None, description="The ID of the chat session, if continuing an existing one.")
    doc_context: Optional[str] = Field(None, description="Optional extracted document content context.")
    is_voice: Optional[bool] = Field(False, description="Whether this request is from voice mode.")

class ChatRenameRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=255, description="New title for the chat session.")

class MessageResponseDB(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime

    class Config:
        from_attributes = True

class ChatResponseDB(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class ChatHistoryResponseDB(ChatResponseDB):
    messages: List[MessageResponseDB]

