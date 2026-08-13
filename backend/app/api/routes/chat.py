from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from typing import List
from sqlalchemy.orm import Session
from app.schemas.chat import ChatRequest, ChatResponse, ChatResponseDB, ChatHistoryResponseDB, ChatRenameRequest
from app.schemas.user import UserResponse
from app.services.chat_service import chat_service
from app.api.dependencies import get_current_user, get_db

router = APIRouter()

@router.get("/", response_model=List[ChatResponseDB])
def get_chats(
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get all chats for the current user."""
    return chat_service.get_user_chats(current_user.id, db)

@router.get("/{chat_id}", response_model=ChatHistoryResponseDB)
def get_chat_history(
    chat_id: int,
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get history for a specific chat."""
    chat = chat_service.get_chat_history(chat_id, current_user.id, db)
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return chat

@router.post("/", response_model=ChatResponse)
async def chat_endpoint(
    request: ChatRequest,
    current_user: UserResponse = Depends(get_current_user)
):
    """
    Send a message to the AI and get a response.
    Requires authentication.
    """
    return await chat_service.process_chat(request, current_user)

@router.post("/stream")
async def chat_stream_endpoint(
    request: ChatRequest,
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Send a message to the AI and get a streaming response via SSE.
    Requires authentication.
    """
    generator = chat_service.process_streaming_chat(request, current_user, db)
    return StreamingResponse(generator, media_type="text/event-stream")

@router.post("/{chat_id}/regenerate")
async def regenerate_chat_endpoint(
    chat_id: int,
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Regenerate the latest assistant response for a chat via SSE.
    Requires authentication.
    """
    generator = chat_service.process_regenerate_stream(chat_id, current_user, db)
    return StreamingResponse(generator, media_type="text/event-stream")

@router.delete("/{chat_id}")
def delete_chat_endpoint(
    chat_id: int,
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Delete a specific chat and all its associated messages for the current user.
    Requires authentication.
    """
    success = chat_service.delete_chat(chat_id, current_user.id, db)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    return {"message": "Chat deleted successfully", "chat_id": chat_id}

@router.patch("/{chat_id}", response_model=ChatResponseDB)
def rename_chat_endpoint(
    chat_id: int,
    request: ChatRenameRequest,
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Rename a specific chat for the current user.
    Requires authentication.
    """
    try:
        updated_chat = chat_service.rename_chat(chat_id, request.title, current_user.id, db)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    if not updated_chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    return updated_chat
