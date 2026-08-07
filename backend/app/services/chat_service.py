import json
from sqlalchemy.orm import Session, joinedload
from app.ai.service import ai_service
from app.schemas.chat import ChatRequest, ChatResponse
from app.schemas.user import UserResponse
from app.models.chat import Chat
from app.models.message import Message

class ChatService:
    @staticmethod
    async def process_chat(request: ChatRequest, current_user: UserResponse) -> ChatResponse:
        """
        Processes a chat message from a user and returns the AI's response.
        """
        response_content = await ai_service.get_chat_response(
            user_message=request.message,
            user_name=current_user.name
        )
        return ChatResponse(response=response_content)

    @staticmethod
    async def process_streaming_chat(request: ChatRequest, current_user: UserResponse, db: Session):
        """
        Processes a chat message and returns an async generator for streaming the response.
        Persists chats and messages to the database.
        """
        chat_id = request.chat_id
        if not chat_id:
            title = request.message[:50] + "..." if len(request.message) > 50 else request.message
            new_chat = Chat(title=title, user_id=current_user.id)
            db.add(new_chat)
            db.commit()
            db.refresh(new_chat)
            chat_id = new_chat.id
        else:
            chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == current_user.id).first()
            if not chat:
                yield f"data: {json.dumps({'error': 'Chat not found'})}\n\n"
                return

        # Save user message
        user_msg = Message(chat_id=chat_id, role="user", content=request.message)
        db.add(user_msg)
        db.commit()

        # Yield chat_id so frontend knows which chat this is
        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        full_response = ""
        async for chunk in ai_service.stream_chat_response(
            user_message=request.message,
            user_name=current_user.name
        ):
            yield chunk
            if chunk.startswith("data: "):
                try:
                    data = json.loads(chunk[6:].strip())
                    if "token" in data:
                        full_response += data["token"]
                except json.JSONDecodeError:
                    pass
        
        # Save assistant message
        if full_response:
            assistant_msg = Message(chat_id=chat_id, role="assistant", content=full_response)
            db.add(assistant_msg)
            db.commit()

    @staticmethod
    def get_user_chats(user_id: int, db: Session):
        return db.query(Chat).filter(Chat.user_id == user_id).order_by(Chat.updated_at.desc()).all()

    @staticmethod
    def get_chat_history(chat_id: int, user_id: int, db: Session):
        return db.query(Chat).options(joinedload(Chat.messages)).filter(Chat.id == chat_id, Chat.user_id == user_id).first()

chat_service = ChatService()
