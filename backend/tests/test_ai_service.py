"""
AI service behavior: RAG similarity threshold, task-aware sampling, model discovery with TTL cache, token-bounded
history, follow-up retrieval-query augmentation and title sanitization.
Migrated from scripts/test_intelligence_pipeline.py (sections 1, 3-7; the prompt checks of section 2 live in
tests/test_prompts.py). Everything runs on the throwaway test database with Ollama mocked.
"""
import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest

import app.ai.service as ai_service_module
import app.database.init_db  # noqa: F401  (registers every model before Message objects are built below)
from app.ai.client import ollama_client
from app.ai.service import FALLBACK_MODEL, MODEL_CACHE_TTL_SECONDS, PRIMARY_MODEL, AIService, sanitize_title
from app.models.message import Message
from app.services.chat_service import build_retrieval_query, estimate_tokens, select_token_bounded_history
from app.services.rag_service import SIMILARITY_THRESHOLD, rag_service


@pytest.fixture(autouse=True)
def _fresh_model_cache():
    AIService.invalidate_model_cache()
    yield
    AIService.invalidate_model_cache()


# ---------------------------------------------------------------- [1] RAG similarity threshold
@pytest.fixture
def threshold_doc(db_session, make_user):
    """A document with 4 chunks whose cosine similarity to the query [1, 0, 0] is ~0.99, ~0.40, ~0.10 and 0."""
    from app.models.document import Document, DocumentChunk

    user = make_user(name="threshold-user")
    doc = Document(filename="threshold_test.txt", file_type=".txt", file_hash="threshold_test_hash", char_count=100, user_id=user.id)
    db_session.add(doc)
    db_session.commit()
    db_session.refresh(doc)
    chunks = [
        DocumentChunk(document_id=doc.id, chunk_index=0, page_number=1, content="High similarity chunk", embedding_json=json.dumps([0.95, 0.05, 0.0])),
        DocumentChunk(document_id=doc.id, chunk_index=1, page_number=2, content="Medium similarity chunk", embedding_json=json.dumps([0.4, 0.9, 0.0])),
        DocumentChunk(document_id=doc.id, chunk_index=2, page_number=3, content="Low similarity chunk", embedding_json=json.dumps([0.1, 0.99, 0.0])),
        DocumentChunk(document_id=doc.id, chunk_index=3, page_number=4, content="Zero similarity chunk", embedding_json=json.dumps([0.0, 1.0, 0.0])),
    ]
    db_session.add_all(chunks)
    db_session.commit()
    with patch.object(ollama_client, "get_embedding", new_callable=AsyncMock, return_value=[1.0, 0.0, 0.0]):
        yield user, doc, chunks


def _retrieve(db, user, doc, top_k):
    return asyncio.run(rag_service.retrieve_relevant_chunks(query="test query", user_id=user.id, document_id=doc.id, db=db, top_k=top_k))


def test_threshold_is_0_25():
    assert SIMILARITY_THRESHOLD == 0.25


def test_chunks_below_threshold_are_filtered_out(db_session, threshold_doc):
    user, doc, _ = threshold_doc
    results = _retrieve(db_session, user, doc, top_k=5)
    assert [r["content"] for r in results] == ["High similarity chunk", "Medium similarity chunk"]
    assert all(r["similarity"] >= SIMILARITY_THRESHOLD for r in results)


def test_chunk_metadata_is_preserved(db_session, threshold_doc):
    user, doc, _ = threshold_doc
    first = _retrieve(db_session, user, doc, top_k=5)[0]
    assert set(first) >= {"content", "filename", "page_number", "chunk_index", "similarity"}
    assert first["filename"] == "threshold_test.txt"
    assert first["page_number"] == 1
    assert first["chunk_index"] == 0


def test_top_k_limit_is_enforced(db_session, threshold_doc):
    user, doc, _ = threshold_doc
    results = _retrieve(db_session, user, doc, top_k=1)
    assert [r["content"] for r in results] == ["High similarity chunk"]


def test_returns_empty_when_no_chunk_reaches_threshold(db_session, threshold_doc):
    user, doc, chunks = threshold_doc
    db_session.delete(chunks[0])
    db_session.delete(chunks[1])
    db_session.commit()
    assert _retrieve(db_session, user, doc, top_k=4) == []


# ---------------------------------------------------------------- [3] task-aware sampling
@pytest.fixture
def captured_options():
    """Runs stream_chat_response with Ollama mocked and returns the options passed to generate_chat."""

    async def one_token(*args, **kwargs):
        yield {"message": {"content": "Test token"}}

    def run(**kwargs):
        with patch.object(AIService, "get_available_models", new_callable=AsyncMock, return_value=[PRIMARY_MODEL, FALLBACK_MODEL]), \
             patch.object(ollama_client, "generate_chat", new_callable=AsyncMock, side_effect=one_token) as gen:
            async def consume():
                async for _ in AIService.stream_chat_response(**kwargs):
                    pass
            asyncio.run(consume())
            return gen.call_args.kwargs["options"]

    return run


@pytest.mark.parametrize("kwargs, temperature", [
    ({"user_message": "Hello", "is_voice": True}, 0.5),
    ({"user_message": "Summarize this", "has_document": True}, 0.2),
    ({"user_message": "Write a python function to compute fibonacci", "has_document": False}, 0.2),
    ({"user_message": "Tell me a fun fact about space", "has_document": False, "is_voice": False}, 0.7),
])
def test_request_uses_task_sampling_options(captured_options, kwargs, temperature):
    options = captured_options(**kwargs)
    assert options["temperature"] == temperature
    assert options["top_p"] == 0.9


# ---------------------------------------------------------------- [4] dynamic model discovery with TTL
def test_model_discovery_prefers_primary_falls_back_and_caches_with_ttl():
    with patch.object(ollama_client, "list_models", new_callable=AsyncMock) as list_models:
        list_models.return_value = {"models": [{"model": PRIMARY_MODEL}, {"model": FALLBACK_MODEL}]}
        assert asyncio.run(AIService.get_active_model()) == PRIMARY_MODEL

        AIService.invalidate_model_cache()
        list_models.return_value = {"models": [{"model": FALLBACK_MODEL}]}
        assert asyncio.run(AIService.get_active_model()) == FALLBACK_MODEL

        # Within the TTL the cached list is used: Ollama is not asked again
        list_models.reset_mock()
        assert asyncio.run(AIService.get_active_model()) == FALLBACK_MODEL
        assert list_models.call_count == 0

        # After the TTL expires availability is refreshed (dynamic recovery)
        ai_service_module._last_model_check_time = time.time() - (MODEL_CACHE_TTL_SECONDS + 5)
        list_models.return_value = {"models": [{"model": PRIMARY_MODEL}]}
        assert asyncio.run(AIService.get_active_model()) == PRIMARY_MODEL
        assert list_models.call_count == 1


# ---------------------------------------------------------------- [5] token-aware history
def test_token_estimation():
    assert estimate_tokens("1234") == 1
    assert estimate_tokens("12345678") == 2
    assert estimate_tokens("") == 1


def test_short_conversation_keeps_every_message_in_order():
    msgs = [
        Message(chat_id=1, role="user", content="Hello"),
        Message(chat_id=1, role="assistant", content="Hi, how can I help?"),
        Message(chat_id=1, role="user", content="What is 2+2?"),
        Message(chat_id=1, role="assistant", content="4"),
    ]
    selected = select_token_bounded_history(msgs, max_tokens=100)
    assert [m["content"] for m in selected] == ["Hello", "Hi, how can I help?", "What is 2+2?", "4"]


def test_long_conversation_is_bounded_newest_first_and_stays_chronological():
    # 20 messages of ~100 tokens each, budget of 500 tokens
    msgs = [Message(chat_id=1, role="user" if i % 2 == 0 else "assistant", content=f"Message {i:02d}: " + "x" * 385) for i in range(20)]
    bounded = select_token_bounded_history(msgs, max_tokens=500)
    assert len(bounded) <= 6
    assert "Message 19" in bounded[-1]["content"]
    assert "Message 00" not in bounded[0]["content"]
    numbers = [int(m["content"].split(":")[0].replace("Message ", "")) for m in bounded]
    assert numbers == sorted(numbers)


# ---------------------------------------------------------------- [6] follow-up retrieval query augmentation
PRIOR = [
    Message(chat_id=1, role="user", content="The document describes database deadlock as the primary bottleneck."),
    Message(chat_id=1, role="assistant", content="Yes, page 4 mentions lock escalation causes deadlock."),
]


def test_standalone_query_is_not_modified():
    query = "Describe the internal b-tree architecture in detail"
    assert build_retrieval_query(query, [Message(chat_id=1, role="user", content="What is SQLite?")]) == query


def test_anaphoric_follow_up_is_augmented_with_prior_context():
    augmented = build_retrieval_query("How can we fix it?", PRIOR)
    assert "How can we fix it?" in augmented
    assert "deadlock" in augmented or "lock escalation" in augmented


def test_single_word_follow_up_is_augmented():
    augmented = build_retrieval_query("Why?", PRIOR)
    assert "Why?" in augmented
    assert len(augmented) > len("Why?")


# ---------------------------------------------------------------- [7] title sanitization
@pytest.mark.parametrize("raw, expected", [
    ("Python list comprehension", "Python list comprehension"),
    ("Title: Introduction to AI", "Introduction to AI"),
    ('"Docker containerization guide"', "Docker containerization guide"),
    ("### Summary of chapter 1", "Summary of chapter 1"),
])
def test_title_sanitization(raw, expected):
    assert sanitize_title(raw, "fallback") == expected
