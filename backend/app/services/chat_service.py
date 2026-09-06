import json
from sqlalchemy.orm import Session, joinedload
from app.ai.service import ai_service
from app.schemas.chat import ChatRequest
from app.schemas.user import UserResponse
from app.models.chat import Chat
from app.models.message import Message

# Context window bounds
MAX_HISTORY_MESSAGES = 20  # Retain up to 20 most recent messages (approx 10 conversation turns)
MAX_DOC_CONTEXT_CHARS = 12000  # Cap attached document context to ~3,000 tokens to preserve context budget

class ChatService:
    @staticmethod
    async def process_streaming_chat(request: ChatRequest, current_user: UserResponse, db: Session):
        """
        Processes a chat message and returns an async generator for streaming the response.
        Persists chats and messages to the database.
        """
        chat_id = request.chat_id
        is_new_chat = False
        if not chat_id:
            is_new_chat = True
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

        # Fetch existing history for this chat prior to saving new message (bounded to recent turns)
        recent_msgs = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.created_at.desc())
            .limit(MAX_HISTORY_MESSAGES)
            .all()
        )
        recent_msgs.reverse()
        history = [{"role": m.role, "content": m.content} for m in recent_msgs]

        # Save user message
        user_msg = Message(chat_id=chat_id, role="user", content=request.message)
        db.add(user_msg)
        db.commit()

        # Yield chat_id so frontend knows which chat this is
        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        # Append latest user message to history (including bounded document context if provided)
        if request.doc_context:
            doc_text = request.doc_context
            if len(doc_text) > MAX_DOC_CONTEXT_CHARS:
                doc_text = (
                    doc_text[:MAX_DOC_CONTEXT_CHARS]
                    + "\n\n[...Document content truncated to fit context window...]"
                )
            llm_user_content = f"{doc_text}\n\n{request.message}"
        else:
            llm_user_content = request.message
        history.append({"role": "user", "content": llm_user_content})

        full_response = ""
        async for chunk in ai_service.stream_chat_response(
            messages_history=history,
            user_name=current_user.name,
            is_voice=bool(request.is_voice)
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

        # If this was a new chat creation, auto-generate concise AI title
        if is_new_chat:
            try:
                ai_title = await ai_service.generate_title(request.message)
                if ai_title:
                    chat_obj = db.query(Chat).filter(Chat.id == chat_id).first()
                    if chat_obj:
                        chat_obj.title = ai_title
                        db.commit()
            except Exception:
                pass

    @staticmethod
    def get_user_chats(user_id: int, db: Session):
        return db.query(Chat).filter(Chat.user_id == user_id).order_by(Chat.updated_at.desc()).all()

    @staticmethod
    def get_chat_history(chat_id: int, user_id: int, db: Session):
        return db.query(Chat).options(joinedload(Chat.messages)).filter(Chat.id == chat_id, Chat.user_id == user_id).first()

    @staticmethod
    def delete_chat(chat_id: int, user_id: int, db: Session) -> bool:
        """
        Deletes a chat and all associated messages for a user.
        """
        chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
        if not chat:
            return False
        db.delete(chat)
        db.commit()
        return True

    @staticmethod
    def rename_chat(chat_id: int, title: str, user_id: int, db: Session):
        """
        Renames a chat for a user after trimming and validating the title.
        """
        cleaned_title = title.strip()
        if not cleaned_title:
            raise ValueError("Title cannot be empty or whitespace-only")
        if len(cleaned_title) > 255:
            raise ValueError("Title cannot exceed 255 characters")

        chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()
        if not chat:
            return None
        chat.title = cleaned_title
        db.commit()
        db.refresh(chat)
        return chat

    @staticmethod
    async def process_regenerate_stream(chat_id: int, current_user: UserResponse, db: Session):
        """
        Regenerates the latest assistant response for a chat and streams the response via SSE.
        Updates the assistant message in the database upon completion.
        """
        chat = db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == current_user.id).first()
        if not chat:
            yield f"data: {json.dumps({'error': 'Chat not found'})}\n\n"
            return

        existing_msgs = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.created_at.asc()).all()
        if not existing_msgs:
            yield f"data: {json.dumps({'error': 'No messages found in chat'})}\n\n"
            return

        target_assistant_msg = None
        target_index = -1
        for i in range(len(existing_msgs) - 1, -1, -1):
            if existing_msgs[i].role == "assistant":
                target_assistant_msg = existing_msgs[i]
                target_index = i
                break

        if not target_assistant_msg or target_index == 0:
            yield f"data: {json.dumps({'error': 'No assistant message found to regenerate'})}\n\n"
            return

        history_msgs = existing_msgs[:target_index]
        if len(history_msgs) > MAX_HISTORY_MESSAGES:
            history_msgs = history_msgs[-MAX_HISTORY_MESSAGES:]
        history = [{"role": m.role, "content": m.content} for m in history_msgs]

        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        full_response = ""
        try:
            async for chunk in ai_service.stream_chat_response(
                messages_history=history,
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
        finally:
            if full_response:
                target_assistant_msg.content = full_response
                db.commit()

chat_service = ChatService()
