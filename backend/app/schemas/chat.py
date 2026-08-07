from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="The message from the user to the AI.")
    chat_id: Optional[int] = Field(None, description="The ID of the chat session, if continuing an existing one.")

class ChatResponse(BaseModel):
    response: str = Field(..., description="The AI's generated response.")

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

