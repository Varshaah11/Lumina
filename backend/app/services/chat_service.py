import re
import json
import asyncio
import logging
from datetime import datetime, timezone
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload
from app.database.database import SessionLocal, fits_sqlite_integer
from app.ai.service import ai_service
from app.ai.router import intelligence_router
from app.services.rag_service import rag_service
from app.schemas.chat import ChatRequest
from app.schemas.user import UserResponse
from app.models.chat import Chat
from app.models.message import Message
from app.models.document import Document, chat_documents

logger = logging.getLogger(__name__)

# Context window bounds
MAX_HISTORY_TOKENS = 3500  # Token budget for conversation history (~14,000 chars)
MAX_DOC_CONTEXT_CHARS = 12000  # Cap fallback doc context to ~3,000 tokens

# Explicit quiz commands only ("quiz me", "test me", "start quiz"); the bare word "question" must not trigger quiz mode.
QUIZ_REQUEST_RE = re.compile(r"\b(?:quiz\s+me|test\s+me|start\s+(?:a\s+|the\s+|my\s+)?quiz)\b", re.IGNORECASE)

def is_quiz_request(text: str) -> bool:
    return bool(QUIZ_REQUEST_RE.search(text or ""))

def add_message(db: Session, chat_id: int, role: str, content: str) -> Message:
    """Persists a message and bumps the chat's updated_at in the same transaction."""
    msg = Message(chat_id=chat_id, role=role, content=content)
    db.add(msg)
    touch_chat(db, chat_id)
    db.commit()
    return msg

def touch_chat(db: Session, chat_id: int) -> None:
    """Marks a chat as recently active. Does not commit (caller owns the transaction)."""
    db.query(Chat).filter(Chat.id == chat_id).update(
        {Chat.updated_at: datetime.now(timezone.utc)}, synchronize_session=False
    )

# Strong references so fire-and-forget title tasks are not garbage collected mid-flight
_background_tasks: set = set()

async def _generate_title_background(chat_id: int, user_message: str, initial_title: str) -> None:
    """Generates an AI title after the response has been delivered. Never raises."""
    db = SessionLocal()
    try:
        ai_title = await ai_service.generate_title(user_message)
        if ai_title:
            chat_obj = db.query(Chat).filter(Chat.id == chat_id).first()
            # Skip if the chat was deleted or the user renamed it in the meantime
            if chat_obj and chat_obj.title == initial_title:
                chat_obj.title = ai_title
                db.commit()
    except Exception as e:
        logger.warning(f"Background title generation failed for chat {chat_id}: {e}")
    finally:
        db.close()

def schedule_title_generation(chat_id: int, user_message: str, initial_title: str) -> None:
    task = asyncio.create_task(_generate_title_background(chat_id, user_message, initial_title))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

def persist_assistant_message(db: Session, chat_id: int, content: str) -> None:
    """Saves an assistant reply (full or partial). Falls back to a fresh session if the request session is unusable."""
    try:
        add_message(db, chat_id, "assistant", content)
    except Exception as e:
        logger.error(f"Failed to persist assistant message for chat {chat_id}: {e}")
        try:
            db.rollback()
        except Exception:
            pass
        fresh = SessionLocal()
        try:
            add_message(fresh, chat_id, "assistant", content)
        except Exception as e2:
            logger.error(f"Fallback persist of assistant message failed for chat {chat_id}: {e2}")
            fresh.rollback()
        finally:
            fresh.close()

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

MAX_RETRIEVAL_QUERY_CHARS = 300

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
        # The question is never cut: only the context is trimmed to fit, keeping its most recent part
        budget = MAX_RETRIEVAL_QUERY_CHARS - len(current_query) - 1
        if budget <= 0:
            return current_query
        context = " ".join(reversed(context_snippets))[-budget:].lstrip()
        return f"{context} {current_query}" if context else current_query

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
            chat = ChatService.get_owned_chat(chat_id, current_user.id, db)
            if not chat:
                yield f"data: {json.dumps({'error': 'Chat not found'})}\n\n"
                return

        # If a document_id was provided, link it to this chat
        if request.document_id and fits_sqlite_integer(request.document_id):
            doc = (
                db.query(Document)
                .filter(Document.id == request.document_id, Document.user_id == current_user.id)
                .first()
            )
            if doc:
                # Attach (never move) the document: it may be shared with other chats
                rag_service.link_document_to_chat(db, doc.id, chat_id)
                db.commit()

        # Fetch existing history for this chat prior to saving new message
        recent_msgs = (
            db.query(Message)
            .filter(Message.chat_id == chat_id)
            .order_by(Message.id.asc())
            .all()
        )

        # Token-bounded history selection (~3,500 token budget)
        history = select_token_bounded_history(recent_msgs, max_tokens=MAX_HISTORY_TOKENS)

        # Save user message
        add_message(db, chat_id, "user", request.message)

        # Yield chat_id so frontend knows which chat this is
        yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

        # Check if this chat has any associated documents (enabling multi-turn RAG)
        chat_docs = rag_service.get_chat_documents(db, chat_id, current_user.id)

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

        # On the turn that attaches a document, fall back to the stored document text
        # (read server-side) if semantic retrieval matched nothing.
        doc_fallback = ""
        if request.document_id and is_doc_relevant and not rag_context:
            doc_fallback = rag_service.build_fallback_context(
                db, chat_id, current_user.id, MAX_DOC_CONTEXT_CHARS
            )

        # Construct defensive user content for LLM
        has_doc_content = bool(rag_context or doc_fallback)
        if rag_context:
            llm_user_content = f"{rag_context}\n\n<user_question>\n{request.message}\n</user_question>"
        elif doc_fallback:
            doc_text = doc_fallback
            llm_user_content = f"{rag_service.wrap_untrusted_document(doc_text)}\n\n<user_question>\n{request.message}\n</user_question>"
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
        is_quiz = is_quiz_request(request.message) and has_doc_content

        full_response = ""
        completed = False
        try:
            async for chunk in ai_service.stream_chat_response(
                messages_history=history,
                user_name=current_user.name,
                user_profile=user_profile,
                has_document=has_doc_content,
                is_quiz=is_quiz,
                is_voice=bool(request.is_voice)
            ):
                # Count the token before yielding it: if the client stops right after receiving it,
                # the generator is closed at the yield and the saved text must include that token
                if chunk.startswith("data: "):
                    try:
                        data = json.loads(chunk[6:].strip())
                        if "token" in data:
                            full_response += data["token"]
                    except json.JSONDecodeError:
                        pass
                yield chunk
            completed = True
        finally:
            # Runs on normal completion, error, Stop, or client disconnect: keep whatever was generated
            if full_response:
                persist_assistant_message(db, chat_id, full_response)

        # New chat: generate the AI title in the background so the stream closes right away
        if is_new_chat and completed and full_response:
            schedule_title_generation(chat_id, request.message, title)

    @staticmethod
    def get_owned_chat(chat_id: int, user_id: int, db: Session):
        """The chat if it exists and belongs to the user, else None (an id SQLite cannot store matches no chat)."""
        if not fits_sqlite_integer(chat_id):
            return None
        return db.query(Chat).filter(Chat.id == chat_id, Chat.user_id == user_id).first()

    @staticmethod
    def get_user_chats(user_id: int, db: Session):
        return db.query(Chat).filter(Chat.user_id == user_id).order_by(Chat.updated_at.desc()).all()

    @staticmethod
    def get_chat_history(chat_id: int, user_id: int, db: Session):
        if not fits_sqlite_integer(chat_id):
            return None
        return db.query(Chat).options(joinedload(Chat.messages)).filter(Chat.id == chat_id, Chat.user_id == user_id).first()

    @staticmethod
    def delete_chat(chat_id: int, user_id: int, db: Session) -> bool:
        """
        Deletes a chat and all associated messages and document links for a user.
        """
        chat = ChatService.get_owned_chat(chat_id, user_id, db)
        if not chat:
            return False
        doc_ids = [d.id for d in chat.documents]
        db.delete(chat)  # also removes this chat's chat_documents link rows
        db.flush()
        # Documents are shared across chats: only remove the ones no other chat still uses
        for doc_id in doc_ids:
            remaining = db.execute(
                select(func.count()).select_from(chat_documents).where(chat_documents.c.document_id == doc_id)
            ).scalar()
            if not remaining:
                orphan = db.get(Document, doc_id)
                if orphan:
                    db.delete(orphan)
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

        chat = ChatService.get_owned_chat(chat_id, user_id, db)
        if not chat:
            return None
        chat.title = cleaned_title
        db.commit()
        db.refresh(chat)
        return chat

    @staticmethod
    async def process_regenerate_stream(
        chat_id: int,
        current_user: UserResponse,
        db: Session,
        is_voice: bool = False
    ):
        """
        Regenerates the latest assistant response for a chat and streams the response via SSE.
        Maintains RAG retrieval and document context if the chat has associated documents.
        Preserves voice mode behavior if is_voice is True.
        """
        chat = ChatService.get_owned_chat(chat_id, current_user.id, db)
        if not chat:
            yield f"data: {json.dumps({'error': 'Chat not found'})}\n\n"
            return

        existing_msgs = db.query(Message).filter(Message.chat_id == chat_id).order_by(Message.id.asc()).all()
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
        chat_docs = rag_service.get_chat_documents(db, chat_id, current_user.id)
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
        is_quiz = is_quiz_request(target_user_text) and has_doc_content

        full_response = ""
        try:
            async for chunk in ai_service.stream_chat_response(
                messages_history=history,
                user_name=current_user.name,
                user_profile=user_profile,
                has_document=has_doc_content,
                is_quiz=is_quiz,
                is_voice=is_voice
            ):
                if chunk.startswith("data: "):
                    try:
                        data = json.loads(chunk[6:].strip())
                        if "token" in data:
                            full_response += data["token"]
                    except json.JSONDecodeError:
                        pass
                yield chunk
        finally:
            if full_response:
                try:
                    target_assistant_msg.content = full_response
                    touch_chat(db, chat_id)
                    db.commit()
                except Exception as e:
                    logger.error(f"Failed to persist regenerated message for chat {chat_id}: {e}")
                    db.rollback()

    stream_regenerate_response = process_regenerate_stream

chat_service = ChatService()
