import json
import logging
from sqlalchemy.orm import Session, joinedload
from app.ai.service import ai_service
from app.ai.router import intelligence_router
from app.services.rag_service import rag_service
from app.schemas.chat import ChatRequest
from app.schemas.user import UserResponse
from app.models.chat import Chat
from app.models.message import Message
from app.models.document import Document

logger = logging.getLogger(__name__)

# Context window bounds
MAX_HISTORY_TOKENS = 3500  # Token budget for conversation history (~14,000 chars)
MAX_DOC_CONTEXT_CHARS = 12000  # Cap fallback doc context to ~3,000 tokens

def estimate_tokens(text: str) -> int:
    """Lightweight character-based token estimation (~4 characters per token)."""
    return max(1, len(text) // 4)

def select_token_bounded_history(messages: list[Message], max_tokens: int = MAX_HISTORY_TOKENS) -> list[dict]:
    """
    Selects conversation history backwards from the newest message up to the token budget,
    then returns them in chronological order.
    """
    selected = []
    total_tokens = 0
    # Iterate from newest to oldest
    for msg in reversed(messages):
        cost = estimate_tokens(msg.content or "")
        if total_tokens + cost > max_tokens and selected:
            break
        selected.append({"role": msg.role, "content": msg.content})
        total_tokens += cost

    selected.reverse()
    return selected

def build_retrieval_query(current_query: str, recent_messages: list[Message]) -> str:
    """
    Constructs an augmented retrieval query for follow-up questions
    (e.g., 'Why?', 'Explain more', 'How can we fix it?').
    Deterministic and lightweight without additional LLM roundtrips.
    """
    q_clean = current_query.strip()
    words = q_clean.lower().split()

    # Follow-up indicators or very short questions
    follow_up_cues = {
        "why", "why?", "how", "how?", "more", "explain", "explain more",
        "tell me more", "what about it", "what else", "elaborate", "clarify",
        "how can we fix it?", "how to fix it", "fix it", "mitigate it", "details",
        "who", "when", "where", "and then", "next", "expand on that"
    }

    is_follow_up = (
        len(words) <= 5
        or q_clean.lower() in follow_up_cues
        or any(w in ("it", "this", "that", "these", "those", "they", "them", "its") for w in words)
    )

    if not is_follow_up or not recent_messages:
        return current_query

    # Grab previous context from the last 1 or 2 turns
    context_snippets = []
    for msg in reversed(recent_messages):
        text = (msg.content or "").strip()
        if text:
            # Take first 150 characters of recent context to keep retrieval query focused
            snippet = text[:150].replace("\n", " ").strip()
            context_snippets.append(snippet)
            if len(context_snippets) >= 2:
                break

    if context_snippets:
        augmented = f"{' '.join(reversed(context_snippets))} {current_query}"
        return augmented[:300]

    return current_query

class ChatService:
    @staticmethod
    async def process_streaming_chat(request: ChatRequest, current_user: UserResponse, db: Session):
        """
        Processes a chat message and returns an async generator for streaming the response.
        Persists chats and messages to the database and applies semantic RAG retrieval
        when documents are associated with the conversation.
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

        # If a document_id was provided, link it to this chat
        if request.document_id:
            doc = (
                db.query(Document)
                .filter(Document.id == request.document_id, Document.user_id == current_user.id)
                .first()
            )
            if doc and doc.chat_id != chat_id:
                doc.chat_id = chat_id
                db.commit()

        # Fetch existing history for this chat prior to saving new message
        recent_msgs = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.created_at.asc())
            .all()
        )

        # Token-bounded history selection (~3,500 token budget)
        history = select_token_bounded_history(recent_msgs, max_tokens=MAX_HISTORY_TOKENS)

        # Save user message
        user_msg = Message(chat_id=chat_id, role="user", content=request.message)
        db.add(user_msg)
        db.commit()

        # Yield chat_id so frontend knows which chat this is
        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        # Check if this chat has any associated documents (enabling multi-turn RAG)
        chat_docs = (
            db.query(Document)
            .filter(Document.chat_id == chat_id, Document.user_id == current_user.id)
            .all()
        )

        rag_context = ""
        # Only perform RAG retrieval if document is present AND query is relevant to the document
        is_doc_relevant = chat_docs and intelligence_router.is_document_query(request.message)

        if is_doc_relevant:
            try:
                # Augment retrieval query if this is a follow-up question
                retrieval_query = build_retrieval_query(request.message, recent_msgs)
                retrieved_chunks = await rag_service.retrieve_relevant_chunks(
                    query=retrieval_query,
                    user_id=current_user.id,
                    chat_id=chat_id,
                    db=db,
                    top_k=4
                )
                if retrieved_chunks:
                    rag_context = rag_service.build_defensive_context(retrieved_chunks)
            except Exception as e:
                logger.error(f"RAG retrieval error in chat {chat_id}: {e}")

        # Construct defensive user content for LLM
        has_doc_content = bool(rag_context or (request.doc_context and is_doc_relevant))
        if rag_context:
            llm_user_content = f"{rag_context}\n\n<user_question>\n{request.message}\n</user_question>"
        elif request.doc_context and is_doc_relevant:
            # Fallback envelope for direct doc_context if RAG didn't match
            doc_text = request.doc_context
            if len(doc_text) > MAX_DOC_CONTEXT_CHARS:
                doc_text = (
                    doc_text[:MAX_DOC_CONTEXT_CHARS]
                    + "\n\n[...Document content truncated to fit context window...]"
                )
            llm_user_content = f"<uploaded_document>\n{doc_text}\n</uploaded_document>\n\n<user_question>\n{request.message}\n</user_question>"
        else:
            # Pure fast path: normal conversation without document overhead (or unrelated general question in doc chat)
            llm_user_content = request.message

        history.append({"role": "user", "content": llm_user_content})

        user_profile = {
            "name": current_user.name,
            "location": getattr(current_user, "location", None),
            "bio": getattr(current_user, "bio", None),
        }

        # Check if user message is initiating or continuing a quiz
        quiz_triggers = ("quiz me", "start quiz", "test me", "question", "quiz")
        is_quiz = any(qt in request.message.lower() for qt in quiz_triggers) and has_doc_content

        full_response = ""
        async for chunk in ai_service.stream_chat_response(
            messages_history=history,
            user_name=current_user.name,
            user_profile=user_profile,
            has_document=has_doc_content,
            is_quiz=is_quiz,
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
        Deletes a chat and all associated messages and document links for a user.
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
        Maintains RAG retrieval and document context if the chat has associated documents.
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
        history = select_token_bounded_history(history_msgs, max_tokens=MAX_HISTORY_TOKENS)

        # Check if chat has associated documents to re-inject RAG context for the prompt
        chat_docs = (
            db.query(Document)
            .filter(Document.chat_id == chat_id, Document.user_id == current_user.id)
            .all()
        )
        has_doc_content = False
        if chat_docs and history:
            target_user_msg = existing_msgs[target_index - 1]
            if intelligence_router.is_document_query(target_user_msg.content):
                try:
                    retrieval_query = build_retrieval_query(target_user_msg.content, history_msgs[:-1])
                    retrieved_chunks = await rag_service.retrieve_relevant_chunks(
                        query=retrieval_query,
                        user_id=current_user.id,
                        chat_id=chat_id,
                        db=db,
                        top_k=4
                    )
                    if retrieved_chunks:
                        rag_context = rag_service.build_defensive_context(retrieved_chunks)
                        history[-1]["content"] = f"{rag_context}\n\n<user_question>\n{target_user_msg.content}\n</user_question>"
                        has_doc_content = True
                except Exception as e:
                    logger.error(f"RAG regeneration retrieval error in chat {chat_id}: {e}")

        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        user_profile = {
            "name": current_user.name,
            "location": getattr(current_user, "location", None),
            "bio": getattr(current_user, "bio", None),
        }

        target_user_text = existing_msgs[target_index - 1].content if target_index > 0 else ""
        quiz_triggers = ("quiz me", "start quiz", "test me", "question", "quiz")
        is_quiz = any(qt in target_user_text.lower() for qt in quiz_triggers) and has_doc_content

        full_response = ""
        try:
            async for chunk in ai_service.stream_chat_response(
                messages_history=history,
                user_name=current_user.name,
                user_profile=user_profile,
                has_document=has_doc_content,
                is_quiz=is_quiz
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
